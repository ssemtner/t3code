import {
  ClaudeSettings,
  ProjectId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../serverSettings.ts";

const CLAUDE_DRIVER = "claudeAgent";
const MAX_REPORTED_ERROR = 500;

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

export class MachineClaudeUnavailableError extends Schema.TaggedError<MachineClaudeUnavailableError>()(
  "MachineClaudeUnavailableError",
  { providerInstanceId: Schema.NullOr(Schema.String) },
) {
  override get message(): string {
    return this.providerInstanceId === null
      ? "No Claude provider is enabled here, so sessions cannot be received."
      : `${this.providerInstanceId} is not an enabled Claude provider here.`;
  }
}

export interface ClaudeInstance {
  readonly providerInstanceId: ProviderInstanceId;
  readonly configDir: string;
}

/** What opening one Claude session as a thread here came to. */
export type SessionThreadOutcome =
  | { readonly kind: "imported"; readonly threadId: ThreadId }
  | { readonly kind: "updated"; readonly threadId: ThreadId }
  | { readonly kind: "existing"; readonly threadId: ThreadId }
  | { readonly kind: "owned-elsewhere"; readonly threadId: ThreadId }
  | { readonly kind: "transcript-conflict"; readonly threadId: ThreadId | null }
  | { readonly kind: "failed"; readonly reason: string };

const sessionThreadId = (providerInstanceId: ProviderInstanceId, sessionId: string) =>
  ThreadId.make(`import:${providerInstanceId}:${sessionId}`);

/** Claude instance lookup and session-to-thread import shared by receiving and local import. */
export const make = Effect.gen(function* () {
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const hostEnvironment = yield* HostProcess.Environment;

  const resolveClaude = Effect.fn("ClaudeSessionThreads.resolveClaude")(function* (
    requested: ProviderInstanceId | undefined,
  ) {
    const settings = yield* serverSettings.getSettings;
    const defaultId = ProviderInstanceId.make(CLAUDE_DRIVER);
    const configured: ReadonlyArray<[string, ProviderInstanceConfig]> = Object.entries(
      settings.providerInstances,
    );
    // Like the session scanner: an unconfigured default instance is still there.
    const instances = [
      ...configured,
      ...(Object.hasOwn(settings.providerInstances, defaultId)
        ? []
        : [
            [defaultId, { driver: ProviderDriverKind.make(CLAUDE_DRIVER) }] satisfies [
              string,
              ProviderInstanceConfig,
            ],
          ]),
    ]
      .filter(
        ([, config]) => config.driver === CLAUDE_DRIVER && resolveProviderInstanceEnabled(config),
      )
      .map(([instanceId, config]) => ({ instanceId: ProviderInstanceId.make(instanceId), config }));
    const chosen =
      requested === undefined
        ? (instances.find(({ instanceId }) => instanceId === defaultId) ?? instances[0])
        : instances.find(({ instanceId }) => instanceId === requested);
    const claudeConfig =
      chosen === undefined ? Option.none() : decodeClaudeSettings(chosen.config.config ?? {});
    if (chosen === undefined || Option.isNone(claudeConfig)) {
      return yield* new MachineClaudeUnavailableError({ providerInstanceId: requested ?? null });
    }
    const environment = yield* mergeProviderInstanceEnvironment(
      chosen.config.environment,
      hostEnvironment,
    );
    const configDir = yield* resolveClaudeHomePath(claudeConfig.value, environment).pipe(
      Effect.provideService(Path.Path, path),
    );
    return { providerInstanceId: chosen.instanceId, configDir } satisfies ClaudeInstance;
  });

  /** Thread ids that hold this native session here, as EventSink's import guard sees them. */
  const nativeSessionOwners = (providerInstanceId: ProviderInstanceId, sessionId: string) =>
    sql<{ readonly thread_id: string }>`
      SELECT thread_id
      FROM orchestration_v2_projection_provider_threads
      WHERE driver = ${CLAUDE_DRIVER}
        AND provider_instance_id = ${providerInstanceId}
        AND thread_id IS NOT NULL
        AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${sessionId}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((rows) => rows.map((row) => ThreadId.make(row.thread_id))),
    );

  /**
   * Places the session's transcript with `place` (none: a different copy is already there), then
   * imports it as the thread `import:<instance>:<session>`. Nothing is placed for a session
   * another thread already continues.
   */
  const openAsThread = Effect.fn("ClaudeSessionThreads.openAsThread")(
    function* (input: {
      readonly projectId: ProjectId;
      readonly root: string;
      readonly claude: ClaudeInstance;
      readonly sessionId: string;
      readonly place: Effect.Effect<
        Option.Option<{ readonly projectDir: string; readonly changed: boolean }>,
        { readonly message: string }
      >;
    }) {
      const { claude, sessionId } = input;
      const threadId = sessionThreadId(claude.providerInstanceId, sessionId);
      const ownedElsewhere = (owners: ReadonlyArray<ThreadId>) =>
        owners.find((owner) => owner !== threadId);

      const owners = yield* nativeSessionOwners(claude.providerInstanceId, sessionId);
      const otherOwner = ownedElsewhere(owners);
      if (otherOwner !== undefined) {
        return { kind: "owned-elsewhere", threadId: otherOwner } satisfies SessionThreadOutcome;
      }
      const hadThread = owners.includes(threadId);

      const placed = yield* input.place;
      if (Option.isNone(placed)) {
        return {
          kind: "transcript-conflict",
          threadId: hadThread ? threadId : null,
        } satisfies SessionThreadOutcome;
      }
      const imported = yield* importer.importSessionTranscripts({
        projectId: input.projectId,
        expectedWorkspaceRoot: input.root,
        transcripts: [
          {
            providerInstanceId: claude.providerInstanceId,
            filePath: path.join(placed.value.projectDir, `${sessionId}.jsonl`),
          },
        ],
      });
      if (hadThread) {
        return {
          kind: placed.value.changed ? "updated" : "existing",
          threadId,
        } satisfies SessionThreadOutcome;
      }
      if (imported.importedCount > 0) {
        return { kind: "imported", threadId } satisfies SessionThreadOutcome;
      }
      // Another import may have claimed the session meanwhile.
      const after = yield* nativeSessionOwners(claude.providerInstanceId, sessionId);
      const claimedBy = ownedElsewhere(after);
      if (claimedBy !== undefined) {
        return { kind: "owned-elsewhere", threadId: claimedBy } satisfies SessionThreadOutcome;
      }
      return after.includes(threadId)
        ? ({ kind: "existing", threadId } satisfies SessionThreadOutcome)
        : ({
            kind: "failed",
            reason: "The transcript was placed, but could not be opened as a thread.",
          } satisfies SessionThreadOutcome);
    },
    (effect, input) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("machines.session-import-failed", {
            sessionId: input.sessionId,
            error,
          }).pipe(
            Effect.as<SessionThreadOutcome>({
              kind: "failed",
              reason: error.message.slice(0, MAX_REPORTED_ERROR),
            }),
          ),
        ),
      ),
  );

  return { resolveClaude, nativeSessionOwners, openAsThread };
});

export type ClaudeSessionThreads = Effect.Success<typeof make>;
