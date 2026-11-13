// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Digest hashes whole buffers; staged files are hashed while streaming.
import * as NodeCrypto from "node:crypto";

import {
  ClaudeSettings,
  MachineTransferManifest,
  MachineTransferReport,
  ProjectId,
  ThreadId,
  resolveProviderInstanceEnabled,
  type MachineCheckoutDescription,
  type MachineCheckoutIdentity,
  type MachinePrepareResult,
  type MachineSessionSummary,
  type MachineSurvey,
  type MachineSurveyProject,
  type MachineTransferFile,
  type MachineTransferRequest,
  type OrchestrationProjectShell,
  type ServerSettingsError,
  type VcsError,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import {
  claudeProjectDirName,
  listClaudeSessionFiles,
  scanClaudeTranscript,
  type ClaudeTranscriptFileError,
  type ClaudeTranscriptScan,
} from "./ClaudeTranscriptPortability.ts";
import * as WorkingTreeSnapshot from "./WorkingTreeSnapshot.ts";

const OUTGOING_TTL_MS = 60 * 60_000;
const RECENTLY_CHANGED_MS = 60_000;
const DESCRIBED_PROJECTS = 20;
const SESSIONS_PER_PROJECT = 20;
const RECENT_TRANSFERS = 5;
const MAX_CHECKOUT_ERROR_CHARS = 200;
// Runs that may still append to the session's transcript.
const ACTIVE_RUN_STATUSES = ["queued", "preparing", "starting", "running", "waiting"];

export class MachineProjectNotFoundError extends Schema.TaggedError<MachineProjectNotFoundError>()(
  "MachineProjectNotFoundError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Project ${this.projectId.slice(0, 128)} was not found on this machine.`;
  }
}

export class MachineWorktreeNotFoundError extends Schema.TaggedError<MachineWorktreeNotFoundError>()(
  "MachineWorktreeNotFoundError",
  { projectId: Schema.String, worktreePath: Schema.String },
) {
  override get message(): string {
    return "That path is not a worktree of the project's repository.";
  }
}

export class MachineNotRepositoryError extends Schema.TaggedError<MachineNotRepositoryError>()(
  "MachineNotRepositoryError",
  { projectId: Schema.String, root: Schema.String },
) {
  override get message(): string {
    return "The project's folder is not a git checkout.";
  }
}

export class MachineTransferConflictError extends Schema.TaggedError<MachineTransferConflictError>()(
  "MachineTransferConflictError",
  { transferId: Schema.String },
) {
  override get message(): string {
    return `Transfer ${this.transferId} was already prepared with a different request.`;
  }
}

export class MachineTransferNotFoundError extends Schema.TaggedError<MachineTransferNotFoundError>()(
  "MachineTransferNotFoundError",
  { transferId: Schema.String },
) {
  override get message(): string {
    return `Transfer ${this.transferId.slice(0, 128)} was not found.`;
  }
}

type SnapshotError = Effect.Error<
  ReturnType<WorkingTreeSnapshot.WorkingTreeSnapshot["Service"]["applySnapshot"]>
>;

type LookupError =
  | ProjectStore.ProjectStoreV2Error
  | ServerSettingsError
  | SqlError.SqlError
  | VcsError
  | PlatformError.PlatformError;

type CheckoutError =
  | MachineProjectNotFoundError
  | MachineWorktreeNotFoundError
  | MachineNotRepositoryError
  | ProjectStore.ProjectStoreV2Error
  | SnapshotError;

const OutgoingRecord = Schema.Struct({
  preparedFor: Schema.Struct({ sessionId: Schema.String }),
  createdAt: Schema.String,
  /** The checkout the snapshot ref was written in, so release and the sweep can delete it. */
  cwd: Schema.String,
  request: Schema.Struct({
    sourceProjectId: Schema.String,
    sourceWorktreePath: Schema.NullOr(Schema.String),
    sessionIds: Schema.Array(Schema.String),
    workingTree: Schema.Boolean,
  }),
});
type OutgoingRecord = typeof OutgoingRecord.Type;

const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(OutgoingRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(OutgoingRecord));
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(MachineTransferManifest));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(MachineTransferManifest));
const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(MachineTransferReport));
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

// Transfer ids name a directory and a ref, so they share the snapshot id rules.
const isTransferId = (value: string) =>
  value.length <= 128 &&
  /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(value) &&
  !value.endsWith(".lock");

const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, "") || "/";

const sameRequest = (record: OutgoingRecord["request"], request: MachineTransferRequest) =>
  record.sourceProjectId === request.sourceProjectId &&
  record.sourceWorktreePath === (request.sourceWorktreePath ?? null) &&
  record.workingTree === request.workingTree &&
  record.sessionIds.join("\0") === request.sessionIds.join("\0");

interface CachedScan {
  readonly size: number;
  readonly mtimeMs: number;
  readonly rootsKey: string;
  readonly scan: ClaudeTranscriptScan;
}

export class MachineSource extends Context.Service<
  MachineSource,
  {
    readonly survey: (input: {
      readonly projectId?: ProjectId;
      /** 1 to 90, default 14. */
      readonly sinceDays?: number;
    }) => Effect.Effect<MachineSurvey, MachineProjectNotFoundError | LookupError>;
    readonly describeCheckout: (input: {
      readonly projectId: ProjectId;
      readonly worktreePath?: string;
    }) => Effect.Effect<MachineCheckoutIdentity, CheckoutError>;
    /** The identity plus the working tree's entries and stashes. */
    readonly describeWorkingTree: (input: {
      readonly projectId: ProjectId;
      readonly worktreePath?: string;
    }) => Effect.Effect<
      {
        readonly identity: MachineCheckoutIdentity;
        readonly description: MachineCheckoutDescription;
      },
      CheckoutError
    >;
    /** Idempotent per transfer id; waits at most `waitMs` for the staged manifest. */
    readonly prepareTransfer: (
      input: MachineTransferRequest & {
        readonly requesterSessionId: string;
        readonly waitMs: number;
      },
    ) => Effect.Effect<
      MachinePrepareResult,
      | CheckoutError
      | MachineTransferConflictError
      | ClaudeTranscriptFileError
      | LookupError
      | Schema.SchemaError
    >;
    readonly openStagedFile: (input: {
      readonly transferId: string;
      readonly fileIndex: number;
      readonly requesterSessionId: string;
    }) => Effect.Effect<
      { readonly path: string; readonly sizeBytes: number; readonly sha256: string },
      MachineTransferNotFoundError
    >;
    readonly releaseTransfer: (input: {
      readonly transferId: string;
      readonly requesterSessionId: string;
    }) => Effect.Effect<void, MachineTransferNotFoundError | PlatformError.PlatformError>;
    /** Removes staged transfers older than an hour and their snapshot refs. */
    readonly sweepOutgoing: Effect.Effect<void, PlatformError.PlatformError>;
  }
>()("t3/machines/MachineSource") {}

type PrepareError = Effect.Error<ReturnType<MachineSource["Service"]["prepareTransfer"]>>;

interface TransferJob {
  readonly record: OutgoingRecord;
  readonly fiber: Fiber.Fiber<MachineTransferManifest, PrepareError>;
}

const make = Effect.gen(function* () {
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const snapshots = yield* WorkingTreeSnapshot.WorkingTreeSnapshot;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const git = yield* (yield* VcsDriverRegistry.VcsDriverRegistry).get("git").pipe(Effect.orDie);
  const layerScope = yield* Effect.scope;

  const machinesDir = path.join(config.stateDir, "machines");
  const outgoingDir = path.join(machinesDir, "outgoing");
  const incomingDir = path.join(machinesDir, "incoming");
  const transferDir = (transferId: string) => path.join(outgoingDir, transferId);
  const snapshotRef = (transferId: string) =>
    `${WorkingTreeSnapshot.SNAPSHOT_REFS_PREFIX}/${transferId}`;

  const jobs = new Map<string, TransferJob>();
  // Guards the job table and transfer directories; held only for bookkeeping, not staging.
  const transfersLock = yield* Semaphore.make(1);
  let scanCache = new Map<string, CachedScan>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const resolveClaudeConfigDir = Effect.fn("MachineSource.resolveClaudeConfigDir")(function* () {
    const settings = yield* serverSettings.getSettings;
    const hostEnvironment = yield* HostProcess.Environment;
    const instances = Object.entries(settings.providerInstances)
      .filter(
        ([, instance]) =>
          instance.driver === "claudeAgent" && resolveProviderInstanceEnabled(instance),
      )
      .toSorted(([left], [right]) =>
        left === "claudeAgent" ? -1 : right === "claudeAgent" ? 1 : 0,
      )
      .map(([, instance]) => instance);
    for (const instance of instances) {
      const claude = decodeClaudeSettings(instance.config ?? {});
      if (Option.isNone(claude)) continue;
      const instanceEnvironment = yield* mergeProviderInstanceEnvironment(
        instance.environment,
        hostEnvironment,
      );
      return yield* resolveClaudeHomePath(claude.value, instanceEnvironment).pipe(
        Effect.provide(platform),
      );
    }
    // Without an enabled instance the default config dir still holds the user's sessions.
    return yield* resolveClaudeHomePath({ homePath: "" }, hostEnvironment).pipe(
      Effect.provide(platform),
    );
  });

  // The provider-thread projection lookup EventSink uses for unlessNativeThreadOwned.
  const lookupOwners = Effect.fn("MachineSource.lookupOwners")(function* (
    sessionIds: ReadonlyArray<string>,
  ) {
    if (sessionIds.length === 0) return new Map<string, { threadId: ThreadId; active: boolean }>();
    const rows = yield* sql<{
      readonly sessionId: string;
      readonly threadId: string;
      readonly active: number;
    }>`
      SELECT
        json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') AS "sessionId",
        pt.thread_id AS "threadId",
        EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs r
          WHERE r.thread_id = pt.thread_id AND r.status IN ${sql.in(ACTIVE_RUN_STATUSES)}
        ) OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_provider_threads bg
          WHERE bg.thread_id = pt.thread_id
            AND CASE WHEN json_valid(bg.payload_json)
              THEN json_array_length(bg.payload_json, '$.pendingBackgroundTasks') > 0
              ELSE 0 END
        ) AS active
      FROM orchestration_v2_projection_provider_threads pt
      JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
      WHERE pt.driver = 'claudeAgent'
        AND t.deleted_at IS NULL
        AND json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') IN ${sql.in(sessionIds)}
    `.pipe(NodeSqliteClient.readOnly);
    const owners = new Map<string, { threadId: ThreadId; active: boolean }>();
    for (const row of rows) {
      const existing = owners.get(row.sessionId);
      owners.set(row.sessionId, {
        threadId: existing?.threadId ?? ThreadId.make(row.threadId),
        active: (existing?.active ?? false) || row.active === 1,
      });
    }
    return owners;
  });

  const requireProject = Effect.fn("MachineSource.requireProject")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects.getShell(projectId);
    if (Option.isNone(project)) return yield* new MachineProjectNotFoundError({ projectId });
    return project.value;
  });

  const listWorktrees = Effect.fn("MachineSource.listWorktrees")(function* (root: string) {
    const result = yield* git.execute({
      operation: "MachineSource.listWorktrees",
      cwd: root,
      args: ["worktree", "list", "--porcelain"],
    });
    return result.stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  });

  const realPathOrSelf = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));

  /** The directory to describe or snapshot: the project root, or one of its repository's worktrees. */
  const resolveCheckoutCwd = Effect.fn("MachineSource.resolveCheckoutCwd")(function* (
    project: OrchestrationProjectShell,
    worktreePath: string | undefined,
  ) {
    const root = project.workspaceRoot;
    const isRepository =
      (yield* fileSystem.exists(root).pipe(Effect.orElseSucceed(() => false))) &&
      (yield* git.isInsideWorkTree(root).pipe(Effect.orElseSucceed(() => false)));
    if (!isRepository) {
      return yield* new MachineNotRepositoryError({ projectId: project.id, root });
    }
    if (worktreePath === undefined) return root;
    const requested = yield* realPathOrSelf(trimTrailingSlashes(worktreePath));
    const worktrees = yield* listWorktrees(root).pipe(
      Effect.flatMap((paths) => Effect.forEach(paths, realPathOrSelf)),
    );
    if (!worktrees.includes(requested)) {
      return yield* new MachineWorktreeNotFoundError({ projectId: project.id, worktreePath });
    }
    return requested;
  });

  const describeCheckout = Effect.fn("MachineSource.describeCheckout")(function* (input: {
    readonly projectId: ProjectId;
    readonly worktreePath?: string;
  }) {
    const project = yield* requireProject(input.projectId);
    const cwd = yield* resolveCheckoutCwd(project, input.worktreePath);
    const identity = yield* snapshots.describeIdentity(cwd);
    return {
      projectId: project.id,
      projectRoot: project.workspaceRoot,
      ...identity,
    } satisfies MachineCheckoutIdentity;
  });

  const describeWorkingTree = Effect.fn("MachineSource.describeWorkingTree")(function* (input: {
    readonly projectId: ProjectId;
    readonly worktreePath?: string;
  }) {
    const project = yield* requireProject(input.projectId);
    const cwd = yield* resolveCheckoutCwd(project, input.worktreePath);
    const [identity, description] = yield* Effect.all(
      [snapshots.describeIdentity(cwd), snapshots.describeCheckout(cwd)],
      { concurrency: 2 },
    );
    return {
      identity: { projectId: project.id, projectRoot: project.workspaceRoot, ...identity },
      description,
    };
  });

  const mtimeOf = (info: FileSystem.File.Info) =>
    Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() });

  // Scans are cached by file identity so repeated surveys only read transcripts that changed.
  const discoverSessions = Effect.fn("MachineSource.discoverSessions")(function* (
    configDir: string,
    roots: ReadonlyArray<string>,
    modifiedAfterMs: number,
  ) {
    const rootsKey = roots.join("\0");
    const projectsDir = path.join(configDir, "projects");
    const projectDirs = yield* fileSystem
      .readDirectory(projectsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const candidates: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
    for (const projectDir of projectDirs) {
      const entries = yield* fileSystem
        .readDirectory(path.join(projectsDir, projectDir))
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const filePath = path.join(projectsDir, projectDir, entry);
        const info = yield* fileSystem.stat(filePath).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== "File") continue;
        const mtimeMs = mtimeOf(info.value);
        if (mtimeMs < modifiedAfterMs) continue;
        candidates.push({ filePath, size: Number(info.value.size), mtimeMs });
      }
    }
    const nextCache = new Map<string, CachedScan>();
    const scans = yield* Effect.forEach(
      candidates,
      ({ filePath, size, mtimeMs }) => {
        const cached = scanCache.get(filePath);
        if (
          cached !== undefined &&
          cached.size === size &&
          cached.mtimeMs === mtimeMs &&
          cached.rootsKey === rootsKey
        ) {
          nextCache.set(filePath, cached);
          return Effect.succeedSome(cached);
        }
        return scanClaudeTranscript(filePath, roots).pipe(
          Effect.provide(platform),
          Effect.map((scan) => {
            const entry = { size, mtimeMs, rootsKey, scan };
            nextCache.set(filePath, entry);
            return Option.some(entry);
          }),
          Effect.catchTags({
            ClaudeTranscriptFileError: () => Effect.succeed(Option.none<CachedScan>()),
          }),
        );
      },
      { concurrency: 4 },
    );
    // Only files inside the current window stay cached, which bounds the cache.
    scanCache = nextCache;
    return scans.flatMap(Option.toArray);
  });

  const listRecentTransfers = Effect.fn("MachineSource.listRecentTransfers")(function* () {
    const ids = yield* fileSystem
      .readDirectory(incomingDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const reports = yield* Effect.forEach(
      ids,
      (id) => {
        const reportPath = path.join(incomingDir, id, "report.json");
        return Effect.all([
          fileSystem.readFileString(reportPath).pipe(Effect.flatMap(decodeReport)),
          fileSystem.stat(reportPath),
        ]).pipe(
          Effect.map(([report, info]) => Option.some({ report, atMs: mtimeOf(info) })),
          Effect.orElseSucceed(() => Option.none()),
        );
      },
      { concurrency: 4 },
    );
    return reports.flatMap(Option.toArray).toSorted((left, right) => right.atMs - left.atMs);
  });

  const survey = Effect.fn("MachineSource.survey")(function* (input: {
    readonly projectId?: ProjectId;
    readonly sinceDays?: number;
  }) {
    const sinceDays = Math.min(90, Math.max(1, Math.floor(input.sinceDays ?? 14)));
    const shells =
      input.projectId === undefined
        ? (yield* projects.listShells()).filter((project) => !project.archivedAt)
        : [yield* requireProject(input.projectId)];
    const now = yield* Clock.currentTimeMillis;
    const configDir = yield* resolveClaudeConfigDir();
    const roots = [...new Set(shells.map((project) => trimTrailingSlashes(project.workspaceRoot)))];
    const scans = yield* discoverSessions(
      configDir,
      roots,
      now - Duration.toMillis(Duration.days(sinceDays)),
    );
    const owners = yield* lookupOwners(scans.map(({ scan }) => scan.sessionId));
    const transfers = yield* listRecentTransfers();

    const ranked = shells
      .map((project) => {
        const root = trimTrailingSlashes(project.workspaceRoot);
        const touched = scans
          .filter(({ scan }) =>
            scan.roots.some((hit) => hit.root === root && hit.cwdLines + hit.toolPaths > 0),
          )
          .toSorted((left, right) => right.mtimeMs - left.mtimeMs);
        const activity = Math.max(touched[0]?.mtimeMs ?? 0, Date.parse(project.updatedAt) || 0);
        return { project, root, touched, activity };
      })
      .toSorted((left, right) => right.activity - left.activity);

    const surveyed = yield* Effect.forEach(
      ranked,
      ({ project, root, touched }, rank) =>
        Effect.gen(function* () {
          const described = rank < DESCRIBED_PROJECTS;
          const checkout = described
            ? yield* describeCheckout({ projectId: project.id }).pipe(
                Effect.map((identity) => ({ identity, error: null })),
                Effect.catch((error) =>
                  Effect.succeed({
                    identity: null,
                    error: error.message.slice(0, MAX_CHECKOUT_ERROR_CHARS),
                  }),
                ),
              )
            : { identity: null, error: null };
          const sessions = described
            ? touched.slice(0, SESSIONS_PER_PROJECT).map(({ scan }): MachineSessionSummary => ({
                sessionId: scan.sessionId,
                title: scan.title,
                firstTimestamp: scan.firstTimestamp,
                lastTimestamp: scan.lastTimestamp,
                size: scan.size,
                lineCount: scan.lineCount,
                projectDirName: scan.projectDirName,
                firstCwd: scan.firstCwd,
                filedElsewhere: scan.projectDirName !== claudeProjectDirName(root),
                roots: scan.roots.filter((hit) => hit.cwdLines + hit.toolPaths > 0),
                existingThreadId: owners.get(scan.sessionId)?.threadId ?? null,
              }))
            : [];
          return {
            projectId: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
            checkout: checkout.identity,
            checkoutError: checkout.error,
            sessions,
            sessionsTruncated: touched.length > sessions.length,
            recentTransfers: transfers
              .filter(({ report }) => report.destination.projectId === project.id)
              .slice(0, RECENT_TRANSFERS)
              .map(({ report, atMs }) => ({
                id: report.transferId,
                status: report.status,
                at: DateTime.formatIso(DateTime.makeUnsafe(atMs)),
              })),
          } satisfies MachineSurveyProject;
        }),
      { concurrency: 4 },
    );

    return {
      environmentId: yield* environment.getEnvironmentId,
      generatedAt: yield* nowIso,
      projects: surveyed,
    } satisfies MachineSurvey;
  });

  // Untraced: one call per staged file, inside the prepare job's span.
  const copyHashed = Effect.fnUntraced(function* (from: string, to: string) {
    yield* fileSystem.makeDirectory(path.dirname(to), { recursive: true });
    const hash = NodeCrypto.createHash("sha256");
    let sizeBytes = 0;
    yield* fileSystem.stream(from).pipe(
      Stream.map((chunk) => {
        hash.update(chunk);
        sizeBytes += chunk.byteLength;
        return chunk;
      }),
      Stream.run(fileSystem.sink(to)),
    );
    return { sizeBytes, sha256: hash.digest("hex") };
  });

  const hashFile = Effect.fnUntraced(function* (filePath: string) {
    let sizeBytes = 0;
    const hash = yield* fileSystem.stream(filePath).pipe(
      Stream.runFold(
        () => NodeCrypto.createHash("sha256"),
        (current, chunk: Uint8Array) => {
          sizeBytes += chunk.byteLength;
          return current.update(chunk);
        },
      ),
    );
    return { sizeBytes, sha256: hash.digest("hex") };
  });

  const bundlePath = (transferId: string) => path.join(transferDir(transferId), "bundle.git");
  const sessionFilePath = (transferId: string, sessionId: string, relativePath: string) =>
    path.join(transferDir(transferId), "sessions", sessionId, ...relativePath.split("/"));
  const stagedPath = (transferId: string, file: MachineTransferFile) =>
    file.kind === "bundle"
      ? bundlePath(transferId)
      : sessionFilePath(transferId, file.sessionId ?? "", file.relativePath ?? "");

  const stageTransfer = Effect.fn("MachineSource.stageTransfer")(function* (input: {
    readonly request: MachineTransferRequest;
    readonly project: OrchestrationProjectShell;
    readonly cwd: string;
    readonly createdAt: string;
  }) {
    const { request, project, cwd } = input;
    const transferId = request.transferId;
    const files: Array<MachineTransferFile> = [];
    const warnings: Array<string> = [];

    let checkout: MachineTransferManifest["checkout"] = null;
    if (request.workingTree) {
      const description = yield* snapshots.describeCheckout(cwd);
      const snapshotCommit = yield* snapshots.snapshotWorkingTree(cwd, transferId);
      const branchRef = description.branch === null ? null : `refs/heads/${description.branch}`;
      yield* snapshots.createTransferBundle(cwd, {
        refs: [snapshotRef(transferId), ...(branchRef === null ? [] : [branchRef])],
        haves: request.haves,
        outputPath: bundlePath(transferId),
      });
      files.push({
        index: files.length,
        kind: "bundle",
        ...(yield* hashFile(bundlePath(transferId))),
      });
      checkout = { description, snapshotCommit, snapshotRef: snapshotRef(transferId), branchRef };
    }

    const configDir = yield* resolveClaudeConfigDir();
    const sessionIds = [...new Set(request.sessionIds)];
    const owners = yield* lookupOwners(sessionIds);
    const now = yield* Clock.currentTimeMillis;
    const sessions: Array<MachineTransferManifest["sessions"][number]> = [];
    for (const sessionId of sessionIds) {
      if (owners.get(sessionId)?.active === true) {
        sessions.push({ sessionId, title: null, status: "busy" });
        continue;
      }
      const listing = yield* listClaudeSessionFiles({ configDir, sessionId }).pipe(
        Effect.provide(platform),
        Effect.asSome,
        Effect.catchTags({
          ClaudeSessionNotFoundError: () => Effect.succeedNone,
          ClaudeSessionPathError: () => Effect.succeedNone,
        }),
      );
      if (Option.isNone(listing)) {
        sessions.push({ sessionId, title: null, status: "missing" });
        continue;
      }
      for (const { relativePath } of listing.value.files) {
        const digest = yield* copyHashed(
          path.join(listing.value.projectDir, ...relativePath.split("/")),
          sessionFilePath(transferId, sessionId, relativePath),
        );
        files.push({ index: files.length, kind: "session", sessionId, relativePath, ...digest });
      }
      const transcript = path.join(listing.value.projectDir, `${sessionId}.jsonl`);
      const changedAt = yield* fileSystem.stat(transcript).pipe(Effect.map(mtimeOf));
      if (now - changedAt < RECENTLY_CHANGED_MS) {
        warnings.push(
          `Session ${sessionId} changed in the last minute, so its copy may miss its newest messages.`,
        );
      }
      const title = yield* scanClaudeTranscript(
        sessionFilePath(transferId, sessionId, `${sessionId}.jsonl`),
        [],
      ).pipe(
        Effect.provide(platform),
        Effect.map((scan) => scan.title),
        Effect.orElseSucceed(() => null),
      );
      sessions.push({ sessionId, title, status: "staged" });
    }

    const checkoutRoot = yield* snapshots.describeIdentity(cwd).pipe(
      Effect.map((identity) => identity.checkoutRoot),
      Effect.orElseSucceed(() => null),
    );
    const worktreeRoots = yield* listWorktrees(cwd).pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    const manifest: MachineTransferManifest = {
      transferId,
      createdAt: input.createdAt,
      source: {
        environmentId: yield* environment.getEnvironmentId,
        homeDir: yield* HostProcess.HomeDirectory,
        claudeConfigDir: configDir,
        projectId: project.id,
        projectRoot: project.workspaceRoot,
        checkoutRoot,
        worktreeRoots: worktreeRoots.filter(
          (root) => root !== checkoutRoot && root !== project.workspaceRoot,
        ),
      },
      checkout,
      files,
      sessions,
      warnings,
    };
    // Written last and renamed into place: its presence means every staged file is complete.
    const manifestPath = path.join(transferDir(transferId), "manifest.json");
    yield* fileSystem.writeFileString(`${manifestPath}.tmp`, yield* encodeManifest(manifest));
    yield* fileSystem.rename(`${manifestPath}.tmp`, manifestPath);
    return manifest;
  });

  const readRecord = (transferId: string) =>
    fileSystem
      .readFileString(path.join(transferDir(transferId), "request.json"))
      .pipe(Effect.flatMap(decodeRecord), Effect.option);

  const readManifest = (transferId: string) =>
    fileSystem
      .readFileString(path.join(transferDir(transferId), "manifest.json"))
      .pipe(Effect.flatMap(decodeManifest), Effect.option);

  // Untraced: callers hold the transfers lock and carry the span.
  const removeStaged = Effect.fnUntraced(function* (
    transferId: string,
    record: Option.Option<OutgoingRecord>,
  ) {
    jobs.delete(transferId);
    if (Option.isSome(record) && record.value.request.workingTree) {
      yield* snapshots
        .deleteRefs(record.value.cwd, [snapshotRef(transferId)])
        .pipe(
          Effect.catch(() =>
            Effect.logWarning("machines.outgoing-snapshot-ref-not-deleted", { transferId }),
          ),
        );
    }
    yield* fileSystem.remove(transferDir(transferId), { recursive: true, force: true });
  });

  const discard = Effect.fnUntraced(function* (
    transferId: string,
    record: Option.Option<OutgoingRecord>,
  ) {
    const job = jobs.get(transferId);
    if (job !== undefined) yield* Fiber.interrupt(job.fiber);
    yield* removeStaged(transferId, record);
  });

  const sweepUnlocked = Effect.fn("MachineSource.sweepOutgoing")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const entries = yield* fileSystem
      .readDirectory(outgoingDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const transferId of entries) {
      const record = yield* readRecord(transferId);
      const createdAtMs = Option.isSome(record)
        ? Date.parse(record.value.createdAt)
        : yield* fileSystem.stat(transferDir(transferId)).pipe(
            Effect.map(mtimeOf),
            Effect.orElseSucceed(() => 0),
          );
      if (Number.isFinite(createdAtMs) && now - createdAtMs < OUTGOING_TTL_MS) continue;
      yield* discard(transferId, record);
    }
  });

  const sweepOutgoing = transfersLock.withPermits(1)(sweepUnlocked());

  const startJob = Effect.fn("MachineSource.startJob")(function* (
    input: MachineTransferRequest & { readonly requesterSessionId: string },
  ) {
    const transferId = input.transferId;
    const job = jobs.get(transferId);
    const record = job === undefined ? yield* readRecord(transferId) : Option.some(job.record);
    if (Option.isSome(record)) {
      if (
        record.value.preparedFor.sessionId !== input.requesterSessionId ||
        !sameRequest(record.value.request, input)
      ) {
        return yield* new MachineTransferConflictError({ transferId });
      }
      if (job !== undefined) return job.fiber;
      const manifest = yield* readManifest(transferId);
      if (Option.isSome(manifest)) return manifest.value;
      // Staged before a restart and never finished: start over.
      yield* discard(transferId, record);
    }

    const project = yield* requireProject(input.sourceProjectId);
    const cwd = yield* resolveCheckoutCwd(project, input.sourceWorktreePath).pipe(
      Effect.catchTags({
        // Sessions alone do not need a repository.
        MachineNotRepositoryError: (error) =>
          input.workingTree ? Effect.fail(error) : Effect.succeed(project.workspaceRoot),
      }),
    );
    const createdAt = yield* nowIso;
    const fresh: OutgoingRecord = {
      preparedFor: { sessionId: input.requesterSessionId },
      createdAt,
      cwd,
      request: {
        sourceProjectId: input.sourceProjectId,
        sourceWorktreePath: input.sourceWorktreePath ?? null,
        sessionIds: input.sessionIds,
        workingTree: input.workingTree,
      },
    };
    yield* fileSystem.makeDirectory(transferDir(transferId), { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(transferDir(transferId), "request.json"),
      yield* encodeRecord(fresh),
    );
    const fiber = yield* stageTransfer({ request: input, project, cwd, createdAt }).pipe(
      // A failed job leaves nothing behind, so the next prepare starts over. Interruption comes
      // from discard, which cleans up while holding the lock.
      Effect.onError((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : transfersLock
              .withPermits(1)(removeStaged(transferId, Option.some(fresh)))
              .pipe(Effect.ignore),
      ),
      Effect.forkIn(layerScope),
    );
    jobs.set(transferId, { record: fresh, fiber });
    return fiber;
  });

  const prepareTransfer = Effect.fn("MachineSource.prepareTransfer")(function* (
    input: MachineTransferRequest & {
      readonly requesterSessionId: string;
      readonly waitMs: number;
    },
  ) {
    yield* Effect.annotateCurrentSpan({ "machines.transfer_id": input.transferId });
    if (!isTransferId(input.transferId)) {
      return yield* new WorkingTreeSnapshot.MachineRefNameInvalidError({ value: input.transferId });
    }
    const started = yield* transfersLock.withPermits(1)(
      sweepUnlocked().pipe(Effect.andThen(startJob(input))),
    );
    if (!Fiber.isFiber(started)) return { status: "ready", manifest: started } as const;
    if (input.waitMs <= 0) {
      const exit = started.pollUnsafe();
      if (exit === undefined) return { status: "preparing" } as const;
      return { status: "ready", manifest: yield* exit } as const;
    }
    const done = yield* Fiber.join(started).pipe(
      Effect.timeoutOption(Duration.millis(input.waitMs)),
    );
    return Option.isNone(done)
      ? ({ status: "preparing" } as const)
      : ({ status: "ready", manifest: done.value } as const);
  });

  const requireOwnTransfer = Effect.fnUntraced(function* (
    transferId: string,
    requesterSessionId: string,
  ) {
    const record = isTransferId(transferId) ? yield* readRecord(transferId) : Option.none();
    if (Option.isNone(record) || record.value.preparedFor.sessionId !== requesterSessionId) {
      return yield* new MachineTransferNotFoundError({ transferId });
    }
    return record;
  });

  const openStagedFile = Effect.fn("MachineSource.openStagedFile")(function* (input: {
    readonly transferId: string;
    readonly fileIndex: number;
    readonly requesterSessionId: string;
  }) {
    yield* requireOwnTransfer(input.transferId, input.requesterSessionId);
    const manifest = yield* readManifest(input.transferId);
    const file = Option.isSome(manifest)
      ? manifest.value.files.find((candidate) => candidate.index === input.fileIndex)
      : undefined;
    if (file === undefined) {
      return yield* new MachineTransferNotFoundError({ transferId: input.transferId });
    }
    return {
      path: stagedPath(input.transferId, file),
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    };
  });

  const releaseTransfer = Effect.fn("MachineSource.releaseTransfer")(function* (input: {
    readonly transferId: string;
    readonly requesterSessionId: string;
  }) {
    yield* transfersLock.withPermits(1)(
      requireOwnTransfer(input.transferId, input.requesterSessionId).pipe(
        Effect.flatMap((record) => discard(input.transferId, record)),
      ),
    );
  });

  yield* sweepOutgoing.pipe(
    Effect.catch((error) => Effect.logWarning("machines.outgoing-sweep-failed", { error })),
  );

  return MachineSource.of({
    survey,
    describeCheckout,
    describeWorkingTree,
    prepareTransfer,
    openStagedFile,
    releaseTransfer,
    sweepOutgoing,
  });
});

export const layer = Layer.effect(MachineSource, make);
