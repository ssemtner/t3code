import {
  ClaudeSettings,
  EnvironmentId,
  type MachineCheckoutDescription,
  type MachineReceiveInput,
  MachineTransferManifest,
  MachineTransferReport,
  type MachineWorkingTreeMode,
  type MachineWorkingTreeReport,
  PeerLinkError,
  ProjectId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { compareCheckouts } from "@t3tools/shared/machinesCheckout";
import {
  importClaudeSession,
  isSessionRelativePath,
  isValidSessionId,
} from "./ClaudeTranscriptPortability.ts";
import * as MachinePeerClient from "./MachinePeerClient.ts";
import { MachineTransferNotFoundError } from "./MachineSource.ts";
import {
  pickDestinationProject,
  planWorkingTree,
  transcriptMappings,
  workingTreeReportFields,
} from "./MachinesPlan.ts";
import * as WorkingTreeSnapshot from "./WorkingTreeSnapshot.ts";

export class MachineSourceUnavailableError extends Schema.TaggedError<MachineSourceUnavailableError>()(
  "MachineSourceUnavailableError",
  {
    environmentId: EnvironmentId,
    /** Why the link itself could not be used, when it could not. */
    linkReason: Schema.NullOr(PeerLinkError.fields.reason),
    /** The source's HTTP status, when it answered. */
    status: Schema.NullOr(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.linkReason) {
      case "disabled":
        return "Linked environments is off on this machine. Turn it on in Settings → Labs.";
      case "unknown_link":
        return `This machine is not linked to ${this.environmentId}.`;
      case "expired":
        return "The link to the source machine expired. Link it again with a new pairing code.";
      case "incompatible":
        return "The source machine runs a T3 Code version that cannot keep a linked agent's limits. Update it, then link again.";
      case null:
        break;
      default:
        return "The source machine did not answer.";
    }
    switch (this.status) {
      case null:
        return "The source machine did not answer.";
      case 401:
        return "The source machine no longer accepts this link. It may have been revoked there; link it again.";
      case 403:
        return "The source machine refused: Linked environments may be off there, or this link is read-only.";
      case 404:
        return "The source machine has no such project or worktree.";
      default:
        return `The source machine could not describe the project (HTTP ${this.status}).`;
    }
  }
}

export class MachineNoMatchingProjectError extends Schema.TaggedError<MachineNoMatchingProjectError>()(
  "MachineNoMatchingProjectError",
  { sourceProjectId: ProjectId, requestedProjectId: Schema.NullOr(ProjectId) },
) {
  override get message(): string {
    return this.requestedProjectId === null
      ? "No project here is a checkout of the source project's repository. Add one, or name the destination project."
      : `Project ${this.requestedProjectId} does not exist here.`;
  }
}

export class MachineAmbiguousProjectError extends Schema.TaggedError<MachineAmbiguousProjectError>()(
  "MachineAmbiguousProjectError",
  { candidates: Schema.Array(ProjectId) },
) {
  override get message(): string {
    return `Several projects here are checkouts of the source project's repository (${this.candidates.join(", ")}). Name the destination project.`;
  }
}

export class MachineUnrelatedProjectError extends Schema.TaggedError<MachineUnrelatedProjectError>()(
  "MachineUnrelatedProjectError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} is not a checkout of the source project's repository, so it cannot receive its working tree.`;
  }
}

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

export class MachineUndoUnavailableError extends Schema.TaggedError<MachineUndoUnavailableError>()(
  "MachineUndoUnavailableError",
  {
    transferId: Schema.String,
    reason: Schema.Literals([
      "running",
      "not-applied",
      "already-undone",
      "superseded",
      "snapshot-missing",
      "head-moved",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "running":
        return `Transfer ${this.transferId} is still running.`;
      case "not-applied":
        return `Transfer ${this.transferId} did not change the working tree, so there is nothing to undo.`;
      case "already-undone":
        return `Transfer ${this.transferId} was already undone.`;
      case "superseded":
        return `A later transfer was applied over transfer ${this.transferId}; undo that one first.`;
      case "snapshot-missing":
        return `The snapshots of transfer ${this.transferId} were cleaned up, so it can no longer be undone.`;
      case "head-moved":
        return `HEAD moved since transfer ${this.transferId} was applied, so it can no longer be undone.`;
    }
  }
}

export class MachineCheckoutBusyError extends Schema.TaggedError<MachineCheckoutBusyError>()(
  "MachineCheckoutBusyError",
  { root: Schema.String, threadIds: Schema.Array(ThreadId) },
) {
  override get message(): string {
    return `Threads are working in ${this.root} (${this.threadIds.join(", ")}). Wait for them to finish.`;
  }
}

export class MachineManifestInvalidError extends Schema.TaggedError<MachineManifestInvalidError>()(
  "MachineManifestInvalidError",
  {
    transferId: Schema.String,
    problem: Schema.Literals(["transfer-id", "session", "file", "bundle"]),
  },
) {
  override get message(): string {
    return `The source machine's answer for transfer ${this.transferId} is not usable (${this.problem}).`;
  }
}

type SnapshotError = Effect.Error<
  ReturnType<WorkingTreeSnapshot.WorkingTreeSnapshot["Service"]["applySnapshot"]>
>;

export class MachineReceiver extends Context.Service<
  MachineReceiver,
  {
    /**
     * Pulls sessions and the working tree from a linked machine. The transfer runs on after
     * `waitMs`; asking again with its `transferId` returns its report so far.
     */
    readonly receive: (
      input: MachineReceiveInput & {
        readonly callerThreadId?: ThreadId;
        readonly waitMs: number;
      },
    ) => Effect.Effect<
      MachineTransferReport,
      | MachineSourceUnavailableError
      | MachineNoMatchingProjectError
      | MachineAmbiguousProjectError
      | MachineUnrelatedProjectError
      | MachineClaudeUnavailableError
      | MachineTransferNotFoundError
      | ProjectStore.ProjectStoreV2Error
      | ServerSettingsError
    >;
    /** The live or persisted report of a transfer; never starts one. */
    readonly report: (input: {
      readonly transferId: string;
      readonly waitMs: number;
    }) => Effect.Effect<MachineTransferReport, MachineTransferNotFoundError>;
    /** Restores the working tree a transfer replaced. */
    readonly undo: (input: {
      readonly transferId: string;
      readonly callerThreadId?: ThreadId;
    }) => Effect.Effect<
      MachineTransferReport,
      | MachineTransferNotFoundError
      | MachineUndoUnavailableError
      | MachineCheckoutBusyError
      | SnapshotError
      | Effect.Error<
          ReturnType<ThreadManagementService.ThreadManagementService["Service"]["getThreadShell"]>
        >
    >;
  }
>()("t3/machines/MachineReceiver") {}

const MACHINE_REFS = "refs/t3/machines";
const CLAUDE_DRIVER = "claudeAgent";
const REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_HAVES = 256;
const TRANSFER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const MAX_REPORTED_ERROR = 500;

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(MachineTransferReport));
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(MachineTransferReport));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(MachineTransferManifest));
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

const safetySnapshotId = (transferId: string) => `safety.${transferId}`;
const safetyRefOf = (transferId: string) =>
  `${MACHINE_REFS}/snapshots/${safetySnapshotId(transferId)}`;
const undoSnapshotId = (transferId: string) => `undo.${transferId}`;
const incomingRef = (transferId: string, ref: string) =>
  `${MACHINE_REFS}/incoming/${transferId}/${ref.replace(/^refs\//, "")}`;

const sameRoot = (left: string, right: string) =>
  normalizeProjectPathForComparison(left) === normalizeProjectPathForComparison(right);

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  const message =
    Option.isSome(error) &&
    typeof error.value === "object" &&
    error.value !== null &&
    "message" in error.value &&
    typeof error.value.message === "string"
      ? error.value.message
      : "The transfer failed unexpectedly. The server log has details.";
  return message.slice(0, MAX_REPORTED_ERROR);
};

type ReportUpdate = (report: MachineTransferReport) => MachineTransferReport;

interface Job {
  readonly report: Ref.Ref<MachineTransferReport>;
  readonly done: Deferred.Deferred<void>;
}

interface StoredReport {
  readonly report: MachineTransferReport;
  readonly mtimeMs: number;
}

const make = Effect.gen(function* () {
  const peer = yield* MachinePeerClient.MachinePeerClient;
  const snapshots = yield* WorkingTreeSnapshot.WorkingTreeSnapshot;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const git = yield* (yield* VcsDriverRegistry.VcsDriverRegistry).get("git").pipe(Effect.orDie);
  const homeDir = yield* HostProcess.HomeDirectory;
  const hostEnvironment = yield* HostProcess.Environment;
  const layerScope = yield* Effect.scope;
  const rootLocks = yield* KeyedLock.make<string>();
  const registration = yield* Semaphore.make(1);
  const jobs = new Map<string, Job>();
  // describeIdentity walks history for root commits; HEAD is cheap and keys the result.
  const identities = new Map<
    string,
    {
      readonly head: string | null;
      readonly identity: Pick<MachineCheckoutDescription, "remotes" | "rootCommits"> | null;
    }
  >();
  const incomingDir = path.join(stateDir, "machines", "incoming");
  const transferDir = (transferId: string) => path.join(incomingDir, transferId);
  const reportPath = (transferId: string) => path.join(transferDir(transferId), "report.json");

  const readReport = Effect.fn("MachineReceiver.readReport")(function* (transferId: string) {
    const file = reportPath(transferId);
    const info = yield* fileSystem.stat(file);
    const report = yield* decodeReport(yield* fileSystem.readFileString(file));
    const mtimeMs = Option.match(info.mtime, { onNone: () => 0, onSome: (d) => d.getTime() });
    return { report, mtimeMs } satisfies StoredReport;
  }, Effect.option);

  const writeReport = Effect.fn("MachineReceiver.writeReport")(function* (
    report: MachineTransferReport,
  ) {
    const file = reportPath(report.transferId);
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(
      `${file}.tmp`,
      yield* encodeReport(report).pipe(Effect.orDie),
    );
    yield* fileSystem.rename(`${file}.tmp`, file);
  });

  const listReports = Effect.gen(function* () {
    const ids = yield* fileSystem
      .readDirectory(incomingDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const stored = yield* Effect.forEach(ids, readReport, { concurrency: 8 });
    return stored.flatMap(Option.toArray);
  });

  const isApplied = (report: MachineTransferReport) =>
    report.status === "completed" &&
    report.workingTree?.action === "applied" &&
    report.undo.undoneAt === null;

  /** The snapshot the root's working tree was last made to match by a transfer, if still here. */
  const lastAppliedSnapshot = Effect.fn("MachineReceiver.lastAppliedSnapshot")(function* (
    root: string,
    excludeTransferId: string,
  ) {
    const latest = (yield* listReports)
      .filter(
        ({ report }) =>
          report.transferId !== excludeTransferId &&
          sameRoot(report.destination.root, root) &&
          isApplied(report),
      )
      .toSorted((left, right) => right.mtimeMs - left.mtimeMs)[0];
    const ref = latest?.report.workingTree?.importedRefs?.snapshot;
    if (ref === undefined) return undefined;
    return (
      (yield* snapshots.readRef(root, ref).pipe(Effect.orElseSucceed(() => null))) ?? undefined
    );
  });

  // Reports, their incoming refs and safety snapshots go after 30 days; leftovers of a job that
  // never finished (the server stopped mid-transfer) go at once.
  const sweep = Effect.fn("MachineReceiver.sweep")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const ids = yield* fileSystem
      .readDirectory(incomingDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const transferId of ids) {
      if (jobs.has(transferId)) continue;
      const stored = yield* readReport(transferId);
      if (Option.isSome(stored)) {
        if (now - stored.value.mtimeMs < REPORT_RETENTION_MS) continue;
        const { report } = stored.value;
        const imported = report.workingTree?.importedRefs;
        yield* snapshots
          .deleteRefs(report.destination.root, [
            safetyRefOf(transferId),
            `${MACHINE_REFS}/snapshots/${undoSnapshotId(transferId)}`,
            ...(imported ? [imported.snapshot] : []),
            ...(imported?.branch ? [imported.branch] : []),
          ])
          .pipe(Effect.ignore);
      }
      yield* fileSystem.remove(transferDir(transferId), { recursive: true }).pipe(Effect.ignore);
    }
  });

  /** Threads working in the root, other than the caller: a run or background work in flight. */
  const busyThreads = Effect.fn("MachineReceiver.busyThreads")(function* (
    projectId: ProjectId,
    root: string,
    callerThreadId: ThreadId | undefined,
  ) {
    const candidates = (yield* threads.listActiveShellIndex()).filter(
      (entry) => entry.projectId === projectId && entry.mayBeLive && entry.id !== callerThreadId,
    );
    const shells = yield* Effect.forEach(candidates, (entry) => threads.getThreadShell(entry.id), {
      concurrency: 8,
    });
    return shells.flatMap((shell) =>
      shell !== null &&
      sameRoot(shell.worktreePath ?? root, root) &&
      (shell.activeRunId !== null || (shell.pendingBackgroundTasks?.length ?? 0) > 0)
        ? [shell.id]
        : [],
    );
  });

  const localIdentity = Effect.fn("MachineReceiver.localIdentity")(function* (root: string) {
    const head = yield* git
      .execute({
        operation: "MachineReceiver.head",
        cwd: root,
        args: ["rev-parse", "--verify", "--quiet", "HEAD"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
        Effect.orElseSucceed(() => undefined),
      );
    if (head === undefined) return null;
    const cached = identities.get(root);
    if (cached !== undefined && cached.head === head) return cached.identity;
    const identity = yield* snapshots.describeIdentity(root).pipe(
      Effect.map(({ remotes, rootCommits }) => ({ remotes, rootCommits })),
      Effect.orElseSucceed(() => null),
    );
    identities.set(root, { head, identity });
    return identity;
  });

  const resolveClaude = Effect.fn("MachineReceiver.resolveClaude")(function* (
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
    return { providerInstanceId: chosen.instanceId, configDir };
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

  const lookup = Effect.fn("MachineReceiver.lookup")(function* (
    transferId: string,
    waitMs: number,
  ) {
    const job = jobs.get(transferId);
    if (job !== undefined) {
      yield* Deferred.await(job.done).pipe(Effect.timeoutOption(Math.max(0, waitMs)));
      return Option.some(yield* Ref.get(job.report));
    }
    return Option.map(yield* readReport(transferId), ({ report }) => report);
  });

  interface JobInput {
    readonly transferId: string;
    readonly environmentId: EnvironmentId;
    readonly sourceProjectId: ProjectId;
    readonly sourceWorktreePath: string | undefined;
    readonly sessionIds: ReadonlyArray<string>;
    readonly mode: MachineWorkingTreeMode;
    readonly projectId: ProjectId;
    readonly root: string;
    readonly claude: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly configDir: string;
    } | null;
    readonly callerThreadId: ThreadId | undefined;
  }

  const manifestProblem = (
    input: JobInput,
    manifest: MachineTransferManifest,
  ): MachineManifestInvalidError["problem"] | null => {
    if (manifest.transferId !== input.transferId) return "transfer-id";
    const requested = new Set(input.sessionIds);
    if (
      manifest.sessions.some(
        (session) => !requested.has(session.sessionId) || !isValidSessionId(session.sessionId),
      )
    ) {
      return "session";
    }
    const staged = new Set(
      manifest.sessions
        .filter((session) => session.status === "staged")
        .map((session) => session.sessionId),
    );
    const indices = new Set<number>();
    let bundles = 0;
    for (const file of manifest.files) {
      if (indices.has(file.index)) return "file";
      indices.add(file.index);
      if (file.kind === "bundle") {
        bundles++;
        continue;
      }
      if (
        file.sessionId === undefined ||
        file.relativePath === undefined ||
        !staged.has(file.sessionId) ||
        !isSessionRelativePath(file.sessionId, file.relativePath)
      ) {
        return "file";
      }
    }
    return bundles === (manifest.checkout === null ? 0 : 1) ? null : "bundle";
  };

  const receiveWorkingTree = Effect.fn("MachineReceiver.receiveWorkingTree")(function* (
    input: JobInput & { readonly mode: "auto" | "refs-only" },
    checkout: NonNullable<MachineTransferManifest["checkout"]>,
    bundlePath: string,
  ) {
    const { transferId, root } = input;
    const imported = yield* snapshots.importTransferBundle(root, bundlePath, transferId);
    const snapshotRef = incomingRef(transferId, checkout.snapshotRef);
    if (imported[snapshotRef] !== checkout.snapshotCommit) {
      return yield* new MachineManifestInvalidError({ transferId, problem: "bundle" });
    }
    const branchRef =
      checkout.branchRef === null ? null : incomingRef(transferId, checkout.branchRef);
    const importedRefs = {
      snapshot: snapshotRef,
      branch: branchRef !== null && imported[branchRef] !== undefined ? branchRef : null,
    };

    const source = checkout.description;
    const destination = yield* snapshots.describeCheckout(root);
    const mergeBase =
      source.head !== null && destination.head !== null
        ? yield* snapshots.mergeBase(root, source.head, destination.head)
        : null;
    const replaces = yield* lastAppliedSnapshot(root, transferId);
    const unchangedSinceReceived =
      replaces === undefined
        ? []
        : yield* snapshots.pathsUnchangedSince(
            root,
            replaces,
            destination.entries.map((entry) => entry.path),
          );
    const comparison = compareCheckouts(source, destination, {
      ...(mergeBase === null ? {} : { mergeBase }),
      bHasHeadOfA: true,
      bUnchangedSinceReceived: new Set(unchangedSinceReceived),
    });
    const busy =
      input.mode === "auto" &&
      (yield* busyThreads(input.projectId, root, input.callerThreadId)).length > 0;
    const safetyRef = safetyRefOf(transferId);
    const plan = planWorkingTree({
      mode: input.mode,
      comparison,
      source,
      destinationHead: destination.head,
      // The snapshot is committed on top of the source's HEAD.
      snapshotParent: source.head,
      busy,
      safetyRefExists: (yield* snapshots.readRef(root, safetyRef)) !== null,
    });
    if (plan.action === "apply") {
      yield* snapshots.applySnapshot(root, checkout.snapshotCommit, {
        safetySnapshotId: safetySnapshotId(transferId),
        ...(replaces === undefined ? {} : { replaces }),
      });
    }
    const action = plan.action === "apply" ? "applied" : plan.action;
    return {
      ...workingTreeReportFields({ comparison, source, destination, action, reason: plan.reason }),
      mergeBase,
      importedRefs,
      safetyRef: action === "applied" ? safetyRef : null,
    } satisfies MachineWorkingTreeReport;
  });

  type SessionReport = MachineTransferReport["sessions"][number];

  const receiveSession = Effect.fn("MachineReceiver.receiveSession")(
    function* (
      input: JobInput,
      claude: NonNullable<JobInput["claude"]>,
      sessionId: string,
      files: ReadonlyArray<string>,
      sourceDir: string,
      mappings: ReturnType<typeof transcriptMappings>,
    ) {
      const threadId = ThreadId.make(`import:${claude.providerInstanceId}:${sessionId}`);
      const conflict = (owner: ThreadId | null, reason: string): SessionReport => ({
        sessionId,
        threadId: owner,
        status: "conflict",
        reason,
      });
      const ownedElsewhere = (owners: ReadonlyArray<ThreadId>) =>
        owners.find((owner) => owner !== threadId);

      const owners = yield* nativeSessionOwners(claude.providerInstanceId, sessionId);
      const otherOwner = ownedElsewhere(owners);
      if (otherOwner !== undefined) {
        return conflict(otherOwner, "Another thread here already continues this session.");
      }
      const hadThread = owners.includes(threadId);

      const placed = yield* importClaudeSession({
        sourceDir,
        sessionId,
        files,
        configDir: claude.configDir,
        cwd: input.root,
        mappings,
        onExisting: "replace-if-prefix",
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.asSome,
        Effect.catchTags({ ClaudeSessionConflictError: () => Effect.succeedNone }),
      );
      if (Option.isNone(placed)) {
        return conflict(
          hadThread ? threadId : null,
          "This machine holds a different transcript of this session.",
        );
      }
      const changed = placed.value.files.some((file) => file.status !== "unchanged");
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
          sessionId,
          threadId,
          status: changed ? "updated" : "existing-thread",
        } satisfies SessionReport;
      }
      if (imported.importedCount > 0) {
        return { sessionId, threadId, status: "imported" } satisfies SessionReport;
      }
      // Another import may have claimed the session meanwhile.
      const after = yield* nativeSessionOwners(claude.providerInstanceId, sessionId);
      const claimedBy = ownedElsewhere(after);
      if (claimedBy !== undefined) {
        return conflict(claimedBy, "Another thread here already continues this session.");
      }
      return after.includes(threadId)
        ? ({ sessionId, threadId, status: "existing-thread" } satisfies SessionReport)
        : ({
            sessionId,
            threadId: null,
            status: "skipped",
            reason: "The transcript was placed, but could not be opened as a thread.",
          } satisfies SessionReport);
    },
    (effect, _input, _claude, sessionId) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("machines.session-receive-failed", { sessionId, error }).pipe(
            Effect.as<SessionReport>({
              sessionId,
              threadId: null,
              status: "skipped",
              reason: error.message.slice(0, MAX_REPORTED_ERROR),
            }),
          ),
        ),
      ),
  );

  const runJob = Effect.fn("MachineReceiver.runJob")(function* (input: JobInput, job: Job) {
    yield* Effect.annotateCurrentSpan({ "machines.transfer_id": input.transferId });
    const update = (change: ReportUpdate) => Ref.update(job.report, change);
    const phase = (name: string) => update((report) => ({ ...report, phase: name }));
    const { transferId, environmentId, root } = input;
    const dir = transferDir(transferId);
    const filesDir = path.join(dir, "files");
    let prepareStarted = false;

    const transfer = Effect.gen(function* () {
      yield* phase("preparing");
      yield* fileSystem.makeDirectory(filesDir, { recursive: true });
      const wantsTree = input.mode !== "none";
      const haves = wantsTree
        ? yield* snapshots
            .listRefTips(root, MAX_HAVES)
            .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
        : [];
      prepareStarted = true;
      const manifest = yield* peer.prepare(environmentId, {
        transferId,
        sourceProjectId: input.sourceProjectId,
        ...(input.sourceWorktreePath === undefined
          ? {}
          : { sourceWorktreePath: input.sourceWorktreePath }),
        sessionIds: input.sessionIds,
        workingTree: wantsTree,
        haves,
      });
      const problem = manifestProblem(input, manifest);
      if (problem !== null) {
        return yield* new MachineManifestInvalidError({ transferId, problem });
      }
      yield* fileSystem.writeFileString(
        path.join(dir, "manifest.json"),
        yield* encodeManifest(manifest),
      );

      yield* phase("downloading");
      const sessionDir = (sessionId: string) => path.join(filesDir, "sessions", sessionId);
      const placement = (file: MachineTransferManifest["files"][number]) =>
        file.kind === "bundle"
          ? path.join(filesDir, String(file.index))
          : path.join(sessionDir(file.sessionId!), ...file.relativePath!.split("/"));
      for (const file of manifest.files) {
        const destination = placement(file);
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* peer.download(environmentId, { transferId, file, destination });
      }

      const bundle = manifest.files.find((file) => file.kind === "bundle");
      if (input.mode !== "none" && manifest.checkout !== null && bundle !== undefined) {
        yield* phase("working-tree");
        const workingTree = yield* receiveWorkingTree(
          { ...input, mode: input.mode },
          manifest.checkout,
          placement(bundle),
        );
        yield* update((report) => ({
          ...report,
          workingTree,
          undo: { available: workingTree.action === "applied", undoneAt: null },
        }));
      }

      yield* phase("sessions");
      const claude = input.claude;
      const mappings =
        claude === null
          ? []
          : transcriptMappings({
              sourceRoots: [
                manifest.source.projectRoot,
                ...(manifest.source.checkoutRoot === null ? [] : [manifest.source.checkoutRoot]),
                ...manifest.source.worktreeRoots,
              ],
              sourceCheckoutRoot: manifest.source.checkoutRoot ?? manifest.source.projectRoot,
              destinationRoot: root,
              sourceHome: manifest.source.homeDir,
              destinationHome: homeDir,
              sourceClaudeConfigDir: manifest.source.claudeConfigDir,
              destinationClaudeConfigDir: claude.configDir,
            });
      const sessions = yield* Effect.forEach(manifest.sessions, (session) => {
        if (session.status === "busy") {
          return Effect.succeed<SessionReport>({
            sessionId: session.sessionId,
            threadId: null,
            status: "busy",
            reason: "The session is running on the source machine.",
          });
        }
        if (session.status === "missing" || claude === null) {
          return Effect.succeed<SessionReport>({
            sessionId: session.sessionId,
            threadId: null,
            status: "skipped",
            reason: "The source machine has no such session.",
          });
        }
        const files = manifest.files.flatMap((file) =>
          file.kind === "session" && file.sessionId === session.sessionId && file.relativePath
            ? [file.relativePath]
            : [],
        );
        return receiveSession(
          input,
          claude,
          session.sessionId,
          files,
          sessionDir(session.sessionId),
          mappings,
        );
      });
      yield* update((report) => ({
        ...report,
        sessions,
        status: "completed",
        phase: "completed",
      }));
    });

    const release = Effect.suspend(() =>
      prepareStarted ? peer.release(environmentId, transferId).pipe(Effect.ignore) : Effect.void,
    );
    yield* rootLocks.withLock(root, transfer).pipe(
      // An interrupted transfer (the server stopping) leaves no report, so asking again reruns it.
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("machines.transfer-failed", { transferId, cause }).pipe(
            Effect.andThen(
              update((report) => ({
                ...report,
                status: "failed",
                phase: "failed",
                error: failureMessage(cause),
              })),
            ),
          ),
      ),
      Effect.ensuring(
        Effect.andThen(
          release,
          fileSystem.remove(filesDir, { recursive: true }).pipe(Effect.ignore),
        ),
      ),
    );
    yield* writeReport(yield* Ref.get(job.report)).pipe(
      Effect.catch((error) =>
        Effect.logWarning("machines.report-write-failed", { transferId, error }),
      ),
    );
  });

  const receive: MachineReceiver["Service"]["receive"] = Effect.fn("MachineReceiver.receive")(
    function* (input) {
      if (input.transferId !== undefined) {
        if (!TRANSFER_ID_PATTERN.test(input.transferId)) {
          return yield* new MachineTransferNotFoundError({ transferId: input.transferId });
        }
        const existing = yield* lookup(input.transferId, input.waitMs);
        if (Option.isSome(existing)) return existing.value;
      }
      yield* registration.withPermits(1)(sweep()).pipe(Effect.ignore);
      const transferId = input.transferId ?? `t-${yield* random.uuidV4()}`;
      yield* Effect.annotateCurrentSpan({ "machines.transfer_id": transferId });
      const environmentId = input.sourceEnvironmentId;
      const mode = input.workingTree ?? "auto";
      const sessionIds = input.sessionIds ?? [];

      const sourceIdentity = yield* peer
        .identity(environmentId, {
          projectId: input.sourceProjectId,
          ...(input.sourceWorktreePath === undefined
            ? {}
            : { worktreePath: input.sourceWorktreePath }),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new MachineSourceUnavailableError({
                environmentId,
                linkReason: cause._tag === "PeerLinkError" ? cause.reason : null,
                status: cause._tag === "PeerLinkError" ? null : cause.status,
                cause,
              }),
          ),
        );

      const requested = input.destinationProjectId;
      const shells = (yield* projects.listShells()).filter((shell) =>
        requested === undefined ? (shell.archivedAt ?? null) === null : shell.id === requested,
      );
      const local = yield* Effect.forEach(
        shells,
        (shell) =>
          localIdentity(shell.workspaceRoot).pipe(
            Effect.map((identity) => ({
              projectId: shell.id,
              root: shell.workspaceRoot,
              identity,
            })),
          ),
        { concurrency: 4 },
      );
      const picked = pickDestinationProject({
        source: { root: sourceIdentity.projectRoot, identity: sourceIdentity },
        projects: local,
        ...(requested === undefined ? {} : { requestedProjectId: requested }),
        workingTree: mode !== "none",
      });
      if (picked.kind === "none") {
        return yield* new MachineNoMatchingProjectError({
          sourceProjectId: input.sourceProjectId,
          requestedProjectId: null,
        });
      }
      if (picked.kind === "ambiguous") {
        return yield* new MachineAmbiguousProjectError({ candidates: picked.candidates });
      }
      if (picked.kind === "rejected") {
        return yield* picked.reason === "not-found"
          ? new MachineNoMatchingProjectError({
              sourceProjectId: input.sourceProjectId,
              requestedProjectId: picked.projectId,
            })
          : new MachineUnrelatedProjectError({ projectId: picked.projectId });
      }
      const root = local.find((project) => project.projectId === picked.projectId)!.root;
      const claude =
        sessionIds.length === 0 ? null : yield* resolveClaude(input.providerInstanceId);

      const job = yield* registration.withPermits(1)(
        Effect.gen(function* () {
          // A concurrent call with the same id may have started it during the checks above.
          if (jobs.has(transferId) || Option.isSome(yield* readReport(transferId))) {
            return null;
          }
          const created: Job = {
            report: yield* Ref.make<MachineTransferReport>({
              transferId,
              status: "running",
              phase: "queued",
              sourceEnvironmentId: environmentId,
              destination: { projectId: picked.projectId, root },
              workingTree: null,
              sessions: [],
              undo: { available: false, undoneAt: null },
              error: null,
            }),
            done: yield* Deferred.make<void>(),
          };
          jobs.set(transferId, created);
          yield* runJob(
            {
              transferId,
              environmentId,
              sourceProjectId: input.sourceProjectId,
              sourceWorktreePath: input.sourceWorktreePath,
              sessionIds,
              mode,
              projectId: picked.projectId,
              root,
              claude,
              callerThreadId: input.callerThreadId,
            },
            created,
          ).pipe(
            Effect.ensuring(
              Effect.suspend(() => {
                jobs.delete(transferId);
                return Deferred.succeed(created.done, undefined);
              }),
            ),
            Effect.forkIn(layerScope),
          );
          return created;
        }),
      );
      if (job === null) {
        const existing = yield* lookup(transferId, input.waitMs);
        if (Option.isSome(existing)) return existing.value;
        return yield* new MachineTransferNotFoundError({ transferId });
      }
      yield* Deferred.await(job.done).pipe(Effect.timeoutOption(Math.max(0, input.waitMs)));
      return yield* Ref.get(job.report);
    },
  );

  const report: MachineReceiver["Service"]["report"] = Effect.fn("MachineReceiver.report")(
    function* (input) {
      const found = TRANSFER_ID_PATTERN.test(input.transferId)
        ? yield* lookup(input.transferId, input.waitMs)
        : Option.none();
      if (Option.isNone(found)) {
        return yield* new MachineTransferNotFoundError({ transferId: input.transferId });
      }
      return found.value;
    },
  );

  const undo: MachineReceiver["Service"]["undo"] = Effect.fn("MachineReceiver.undo")(
    function* (input) {
      const { transferId } = input;
      const unavailable = (reason: MachineUndoUnavailableError["reason"]) =>
        new MachineUndoUnavailableError({ transferId, reason });
      if (jobs.has(transferId)) return yield* unavailable("running");
      const initial = TRANSFER_ID_PATTERN.test(transferId)
        ? yield* readReport(transferId)
        : Option.none();
      if (Option.isNone(initial)) return yield* new MachineTransferNotFoundError({ transferId });
      const root = initial.value.report.destination.root;

      return yield* rootLocks.withLock(
        root,
        Effect.gen(function* () {
          const stored = yield* readReport(transferId);
          if (Option.isNone(stored)) return yield* new MachineTransferNotFoundError({ transferId });
          const { report, mtimeMs } = stored.value;
          const workingTree = report.workingTree;
          if (report.undo.undoneAt !== null) return yield* unavailable("already-undone");
          if (
            !isApplied(report) ||
            workingTree?.importedRefs == null ||
            workingTree.safetyRef === null
          ) {
            return yield* unavailable("not-applied");
          }
          const superseded = (yield* listReports).some(
            (other) =>
              other.report.transferId !== transferId &&
              sameRoot(other.report.destination.root, root) &&
              isApplied(other.report) &&
              other.mtimeMs > mtimeMs,
          );
          if (superseded) return yield* unavailable("superseded");
          const [safetyCommit, appliedCommit] = yield* Effect.all([
            snapshots.readRef(root, workingTree.safetyRef),
            snapshots.readRef(root, workingTree.importedRefs.snapshot),
          ]);
          if (safetyCommit === null || appliedCommit === null) {
            return yield* unavailable("snapshot-missing");
          }
          const busy = yield* busyThreads(report.destination.projectId, root, input.callerThreadId);
          if (busy.length > 0) {
            return yield* new MachineCheckoutBusyError({ root, threadIds: busy.slice(0, 10) });
          }
          yield* snapshots
            .applySnapshot(root, safetyCommit, {
              safetySnapshotId: undoSnapshotId(transferId),
              replaces: appliedCommit,
            })
            .pipe(
              Effect.catchTags({
                SnapshotParentMismatchError: () => Effect.fail(unavailable("head-moved")),
              }),
            );
          const undone: MachineTransferReport = {
            ...report,
            undo: { available: false, undoneAt: DateTime.formatIso(yield* DateTime.now) },
          };
          yield* writeReport(undone);
          return undone;
        }),
      );
    },
  );

  yield* sweep().pipe(Effect.ignore);

  return MachineReceiver.of({ receive, report, undo });
});

export const layer = Layer.effect(MachineReceiver, make);
