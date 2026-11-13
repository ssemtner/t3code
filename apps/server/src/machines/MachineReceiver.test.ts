// @effect-diagnostics-next-line nodeBuiltinImport:off -- the fake source hashes staged files as the real one does.
import * as NodeCrypto from "node:crypto";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type MachineTransferFile,
  type MachineTransferManifest,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { claudeProjectDirName, listClaudeSessionFiles } from "./ClaudeTranscriptPortability.ts";
import * as MachinePeerClient from "./MachinePeerClient.ts";
import * as MachineReceiver from "./MachineReceiver.ts";
import * as WorkingTreeSnapshot from "./WorkingTreeSnapshot.ts";

const SOURCE_ENVIRONMENT = EnvironmentId.make("env-machine-a");
const SOURCE_PROJECT = ProjectId.make("project-a");
const DESTINATION_PROJECT = ProjectId.make("project-b");
const CALLER = ThreadId.make("thread-caller");
const OTHER = ThreadId.make("thread-other");
const SESSION = "0b8f5c1e-3d2a-4f6b-9c1d-2e3f4a5b6c7d";
const OWNED_SESSION = "1c8f5c1e-3d2a-4f6b-9c1d-2e3f4a5b6c7d";
const BUSY_SESSION = "2d8f5c1e-3d2a-4f6b-9c1d-2e3f4a5b6c7d";
const WAIT = 10 * 60_000;

const baseLayer = WorkingTreeSnapshot.layer.pipe(
  Layer.provideMerge(VcsDriverRegistry.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
);

const git = Effect.fn("test.git")(function* (cwd: string, ...args: ReadonlyArray<string>) {
  const driver = yield* (yield* VcsDriverRegistry.VcsDriverRegistry).get("git");
  return (yield* driver.execute({ operation: "test.git", cwd, args })).stdout;
});

const write = Effect.fn("test.write")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(path.join(cwd, relativePath)), { recursive: true });
  yield* fileSystem.writeFileString(path.join(cwd, relativePath), contents);
});

const read = Effect.fn("test.read")(function* (cwd: string, relativePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.join(cwd, relativePath);
  return (yield* fileSystem.exists(absolute)) ? yield* fileSystem.readFileString(absolute) : null;
});

const tempDirectory = Effect.fn("test.tempDirectory")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  // Git reports real paths, and macOS temp dirs sit behind a symlink.
  return yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-machines-receiver-" }),
  );
});

const configure = (cwd: string) =>
  Effect.forEach(
    [
      ["user.name", "Test"],
      ["user.email", "test@test.com"],
    ],
    ([key, value]) => git(cwd, "config", key!, value!),
    { discard: true },
  );

const cloneRepo = Effect.fn("test.cloneRepo")(function* (source: string) {
  const cwd = yield* tempDirectory();
  yield* git(cwd, "clone", "-q", source, ".");
  yield* configure(cwd);
  return cwd;
});

const commit = Effect.fn("test.commit")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  yield* write(cwd, relativePath, contents);
  yield* git(cwd, "add", "--", relativePath);
  yield* git(cwd, "commit", "-q", "-m", `edit ${relativePath}`);
});

const repoState = Effect.fn("test.repoState")(function* (cwd: string) {
  return {
    status: yield* git(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
    head: yield* git(cwd, "rev-parse", "HEAD"),
    branches: yield* git(cwd, "for-each-ref", "refs/heads", "refs/remotes"),
  };
});

/** Every tracked or untracked file of the checkout with its contents. */
const checkoutFiles = Effect.fn("test.checkoutFiles")(function* (cwd: string) {
  const listed = yield* git(cwd, "ls-files", "-z", "--cached", "--others", "--exclude-standard");
  const paths = listed
    .split("\0")
    .filter((entry) => entry.length > 0)
    .toSorted();
  return Object.fromEntries(
    yield* Effect.forEach(paths, (entry) =>
      read(cwd, entry).pipe(Effect.map((contents) => [entry, contents] as const)),
    ),
  );
});

const refExists = (cwd: string, ref: string) =>
  git(cwd, "rev-parse", "--verify", "--quiet", ref).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const jsonl = (...records: ReadonlyArray<unknown>) =>
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

/** Two machines in one process: clones of one origin, each with its own home and Claude dir. */
const makeWorld = Effect.fn("test.makeWorld")(function* () {
  const path = yield* Path.Path;
  const origin = yield* tempDirectory();
  yield* git(origin, "init", "-q", "-b", "main");
  yield* configure(origin);
  yield* write(origin, "tracked.txt", "one\n");
  yield* write(origin, "other.txt", "other\n");
  yield* git(origin, "add", "-A");
  yield* git(origin, "commit", "-q", "-m", "initial");
  const homeA = yield* tempDirectory();
  const homeB = yield* tempDirectory();
  return {
    repoA: yield* cloneRepo(origin),
    repoB: yield* cloneRepo(origin),
    homeA,
    homeB,
    configA: path.join(homeA, ".claude"),
    configB: path.join(homeB, ".claude"),
    staging: yield* tempDirectory(),
  };
});
type World = Effect.Success<ReturnType<typeof makeWorld>>;

const writeSession = Effect.fn("test.writeSession")(function* (world: World, sessionId: string) {
  const root = world.repoA;
  const projectDir = `${world.configA}/projects/${claudeProjectDirName(root)}`;
  yield* write(
    projectDir,
    `${sessionId}.jsonl`,
    jsonl(
      {
        type: "user",
        cwd: root,
        sessionId,
        timestamp: "2026-11-13T10:00:00.000Z",
        message: { role: "user", content: "Fix the tracked file" },
      },
      {
        type: "assistant",
        cwd: root,
        sessionId,
        timestamp: "2026-11-13T10:00:05.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Read", input: { file_path: `${root}/tracked.txt` } },
          ],
        },
      },
    ),
  );
  yield* write(
    projectDir,
    `${sessionId}/subagents/agent-1.jsonl`,
    jsonl({ type: "user", cwd: root, message: { role: "user", content: "Look around" } }),
  );
});

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/**
 * Machine A, served from the building blocks the real source uses: a snapshot and bundle of its
 * checkout, and its Claude session files, each hashed.
 */
const makeSource = Effect.fn("test.makeSource")(function* (
  world: World,
  options: {
    readonly gate?: Deferred.Deferred<void>;
    readonly corrupt?: boolean;
    readonly busySessions?: ReadonlyArray<string>;
  } = {},
) {
  const snapshots = yield* WorkingTreeSnapshot.WorkingTreeSnapshot;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const calls = { prepares: 0, releases: [] as Array<string> };
  const staged = new Map<string, string>();

  const prepare = Effect.fn("test.source.prepare")(function* (
    request: Parameters<MachinePeerClient.MachinePeerClient["Service"]["prepare"]>[1],
  ) {
    calls.prepares++;
    if (options.gate !== undefined) yield* Deferred.await(options.gate);
    const directory = path.join(world.staging, request.transferId);
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    const sources: Array<{
      readonly kind: MachineTransferFile["kind"];
      readonly sessionId?: string;
      readonly relativePath?: string;
      readonly path: string;
    }> = [];
    let checkout: MachineTransferManifest["checkout"] = null;
    if (request.workingTree) {
      const snapshotCommit = yield* snapshots.snapshotWorkingTree(world.repoA, request.transferId);
      const description = yield* snapshots.describeCheckout(world.repoA);
      const snapshotRef = `refs/t3/machines/snapshots/${request.transferId}`;
      const branchRef = description.branch === null ? null : `refs/heads/${description.branch}`;
      const bundle = yield* snapshots.createTransferBundle(world.repoA, {
        refs: [snapshotRef, ...(branchRef === null ? [] : [branchRef])],
        haves: request.haves,
        outputPath: path.join(directory, "bundle.git"),
      });
      sources.push({ kind: "bundle", path: bundle.path });
      checkout = { description, snapshotCommit, snapshotRef, branchRef };
    }
    const sessions: Array<MachineTransferManifest["sessions"][number]> = [];
    for (const sessionId of request.sessionIds) {
      if (options.busySessions?.includes(sessionId)) {
        sessions.push({ sessionId, title: null, status: "busy" });
        continue;
      }
      const listed = yield* listClaudeSessionFiles({ configDir: world.configA, sessionId });
      for (const file of listed.files) {
        sources.push({
          kind: "session",
          sessionId,
          relativePath: file.relativePath,
          path: path.join(listed.projectDir, ...file.relativePath.split("/")),
        });
      }
      sessions.push({ sessionId, title: null, status: "staged" });
    }
    const files = yield* Effect.forEach(sources, (source, index) =>
      fileSystem.readFile(source.path).pipe(
        Effect.map((bytes): MachineTransferFile => {
          staged.set(`${request.transferId}/${index}`, source.path);
          return {
            index,
            kind: source.kind,
            ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }),
            ...(source.relativePath === undefined ? {} : { relativePath: source.relativePath }),
            sizeBytes: bytes.length,
            sha256: sha256(bytes),
          };
        }),
      ),
    );
    return {
      transferId: request.transferId,
      createdAt: "2026-11-13T10:00:00.000Z",
      source: {
        environmentId: SOURCE_ENVIRONMENT,
        homeDir: world.homeA,
        claudeConfigDir: world.configA,
        projectId: SOURCE_PROJECT,
        projectRoot: world.repoA,
        checkoutRoot: world.repoA,
        worktreeRoots: [],
      },
      checkout,
      files,
      sessions,
      warnings: [],
    } satisfies MachineTransferManifest;
  });

  const client = MachinePeerClient.MachinePeerClient.of({
    identity: () =>
      snapshots.describeIdentity(world.repoA).pipe(
        Effect.map((identity) => ({
          ...identity,
          projectId: SOURCE_PROJECT,
          projectRoot: world.repoA,
        })),
        Effect.orDie,
      ),
    readConfigItem: () => Effect.die("unused"),
    prepare: (_environmentId, request) =>
      prepare(request).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.orDie,
      ),
    download: (_environmentId, input) =>
      options.corrupt === true
        ? Effect.fail(
            new MachinePeerClient.MachineTransferIntegrityError({
              transferId: input.transferId,
              fileIndex: input.file.index,
              expectedSize: input.file.sizeBytes,
              actualSize: input.file.sizeBytes,
            }),
          )
        : fileSystem
            .copyFile(staged.get(`${input.transferId}/${input.file.index}`)!, input.destination)
            .pipe(Effect.orDie),
    release: (_environmentId, transferId) =>
      Effect.sync(() => {
        calls.releases.push(transferId);
      }),
  });
  return { client, calls };
});

interface DestinationState {
  /** Threads working in the destination root, with or without a run in flight. */
  readonly working: Array<{ readonly id: ThreadId; readonly activeRun: boolean }>;
  readonly imports: Array<unknown>;
}

const destinationLayer = (
  world: World,
  source: MachinePeerClient.MachinePeerClient["Service"],
  state: DestinationState,
) =>
  MachineReceiver.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(MachinePeerClient.MachinePeerClient, source),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () =>
            Effect.succeed([
              {
                id: DESTINATION_PROJECT,
                title: "Project",
                workspaceRoot: world.repoB,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-11-01T00:00:00.000Z",
                updatedAt: "2026-11-01T00:00:00.000Z",
              },
            ]),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          listActiveShellIndex: () =>
            Effect.sync(() =>
              state.working.map((thread) => ({
                id: thread.id,
                projectId: DESTINATION_PROJECT,
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: thread.id,
                },
                settledOverride: null,
                settledAt: null,
                pinnedAt: null,
                snoozedUntil: null,
                mayBeLive: true,
                hasRemoteTasks: false,
              })),
            ),
          getThreadShell: (threadId) =>
            Effect.sync(() => {
              const thread = state.working.find((entry) => entry.id === threadId);
              // The busy check reads only these fields of the shell.
              return thread === undefined
                ? null
                : ({
                    id: thread.id,
                    worktreePath: null,
                    activeRunId: thread.activeRun ? "run-1" : null,
                    pendingBackgroundTasks: [],
                  } as unknown as OrchestrationV2ThreadShell);
            }),
        }),
        Layer.mock(AgentSessionImporter.AgentSessionImporter)({
          importSessionTranscripts: (input) =>
            Effect.sync(() => {
              state.imports.push(input);
              return { importedCount: 1, skippedCount: 0 };
            }),
        }),
        ServerSettings.ServerSettingsService.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: world.configB },
            },
          },
        }),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-machines-receiver-state-" }),
        Layer.fresh(SqlitePersistence.layerMemory),
        Layer.succeed(HostProcess.HomeDirectory, world.homeB),
      ),
    ),
  );

const request = (
  overrides: Partial<Parameters<MachineReceiver.MachineReceiver["Service"]["receive"]>[0]> = {},
) => ({
  sourceEnvironmentId: SOURCE_ENVIRONMENT,
  sourceProjectId: SOURCE_PROJECT,
  workingTree: "auto" as const,
  waitMs: WAIT,
  ...overrides,
});

it.live("applies the source's working tree onto a clean checkout, once, and undo restores it", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld();
    yield* write(world.repoA, "tracked.txt", "edited on a\n");
    yield* write(world.repoA, "new.txt", "new on a\n");
    const before = yield* checkoutFiles(world.repoB);
    const positionBefore = yield* repoState(world.repoB);
    const source = yield* makeSource(world);
    const state: DestinationState = { working: [], imports: [] };

    yield* Effect.gen(function* () {
      const receiver = yield* MachineReceiver.MachineReceiver;
      const report = yield* receiver.receive(request());
      assert.strictEqual(report.status, "completed");
      assert.strictEqual(report.workingTree?.action, "applied");
      assert.strictEqual(report.workingTree?.reason, "safe");
      assert.deepStrictEqual(report.undo, { available: true, undoneAt: null });
      const safetyRef = `refs/t3/machines/snapshots/safety.${report.transferId}`;
      assert.strictEqual(report.workingTree?.safetyRef, safetyRef);
      assert.isTrue(yield* refExists(world.repoB, safetyRef));
      assert.strictEqual(yield* read(world.repoB, "tracked.txt"), "edited on a\n");
      assert.strictEqual(yield* read(world.repoB, "new.txt"), "new on a\n");
      const after = yield* repoState(world.repoB);
      assert.strictEqual(after.head, positionBefore.head);
      assert.strictEqual(after.branches, positionBefore.branches);
      assert.deepStrictEqual(source.calls.releases, [report.transferId]);

      // Asking again returns the stored report and neither prepares nor applies again.
      yield* write(world.repoA, "tracked.txt", "edited again on a\n");
      const again = yield* receiver.receive(request({ transferId: report.transferId }));
      assert.deepStrictEqual(again, report);
      assert.strictEqual(source.calls.prepares, 1);
      assert.strictEqual(yield* read(world.repoB, "tracked.txt"), "edited on a\n");

      const undone = yield* receiver.undo({ transferId: report.transferId });
      assert.isNotNull(undone.undo.undoneAt);
      assert.isFalse(undone.undo.available);
      assert.deepStrictEqual(yield* checkoutFiles(world.repoB), before);
      assert.deepStrictEqual(yield* repoState(world.repoB), positionBefore);
      assert.strictEqual(
        (yield* receiver.undo({ transferId: report.transferId }).pipe(Effect.flip))._tag,
        "MachineUndoUnavailableError",
      );
    }).pipe(Effect.provide(destinationLayer(world, source.client, state)));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.live("imports only refs when the destination has its own edits", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld();
    yield* write(world.repoA, "tracked.txt", "edited on a\n");
    yield* write(world.repoB, "tracked.txt", "edited on b\n");
    const before = yield* checkoutFiles(world.repoB);
    const source = yield* makeSource(world);
    const state: DestinationState = { working: [], imports: [] };

    yield* Effect.gen(function* () {
      const receiver = yield* MachineReceiver.MachineReceiver;
      const report = yield* receiver.receive(request());
      assert.strictEqual(report.status, "completed");
      assert.strictEqual(report.workingTree?.action, "refs-only");
      assert.strictEqual(report.workingTree?.reason, "destination-changes");
      assert.deepStrictEqual(report.workingTree?.blocking, ["tracked.txt"]);
      assert.isNull(report.workingTree?.safetyRef);
      assert.isFalse(report.undo.available);
      assert.deepStrictEqual(yield* checkoutFiles(world.repoB), before);
      assert.isTrue(yield* refExists(world.repoB, report.workingTree!.importedRefs!.snapshot));
    }).pipe(Effect.provide(destinationLayer(world, source.client, state)));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.live(
  "receiving again replaces what the last transfer wrote, unless the destination edited it",
  () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      yield* write(world.repoA, "tracked.txt", "edited on a\n");
      yield* write(world.repoA, "new.txt", "new on a\n");
      const source = yield* makeSource(world);
      const state: DestinationState = { working: [], imports: [] };

      yield* Effect.gen(function* () {
        const receiver = yield* MachineReceiver.MachineReceiver;
        const first = yield* receiver.receive(request());
        assert.strictEqual(first.workingTree?.action, "applied");
        const afterFirst = yield* checkoutFiles(world.repoB);

        yield* write(world.repoA, "tracked.txt", "edited again on a\n");
        yield* git(world.repoA, "clean", "-q", "-f", "--", "new.txt");
        const second = yield* receiver.receive(request());
        assert.strictEqual(second.workingTree?.action, "applied");
        assert.strictEqual(second.workingTree?.reason, "safe");
        assert.deepStrictEqual(second.workingTree?.blocking, []);
        assert.strictEqual(yield* read(world.repoB, "tracked.txt"), "edited again on a\n");
        assert.isNull(yield* read(world.repoB, "new.txt"));

        yield* receiver.undo({ transferId: second.transferId });
        assert.deepStrictEqual(yield* checkoutFiles(world.repoB), afterFirst);

        yield* write(world.repoB, "tracked.txt", "edited on b\n");
        yield* write(world.repoA, "tracked.txt", "edited a third time on a\n");
        const before = yield* checkoutFiles(world.repoB);
        const third = yield* receiver.receive(request());
        assert.strictEqual(third.workingTree?.action, "refs-only");
        assert.strictEqual(third.workingTree?.reason, "destination-changes");
        assert.deepStrictEqual(third.workingTree?.blocking, ["tracked.txt"]);
        assert.deepStrictEqual(yield* checkoutFiles(world.repoB), before);
      }).pipe(Effect.provide(destinationLayer(world, source.client, state)));
    }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.live("imports only refs when the checkouts are on different commits", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld();
    yield* commit(world.repoA, "ahead.txt", "ahead\n");
    yield* write(world.repoA, "tracked.txt", "edited on a\n");
    const before = yield* repoState(world.repoB);
    const files = yield* checkoutFiles(world.repoB);
    const source = yield* makeSource(world);
    const state: DestinationState = { working: [], imports: [] };

    yield* Effect.gen(function* () {
      const receiver = yield* MachineReceiver.MachineReceiver;
      const report = yield* receiver.receive(request());
      assert.strictEqual(report.status, "completed");
      assert.strictEqual(report.workingTree?.action, "refs-only");
      assert.strictEqual(report.workingTree?.reason, "different-head");
      assert.strictEqual(report.workingTree?.headRelation, "source-ahead");
      const imported = report.workingTree!.importedRefs!;
      assert.isTrue(yield* refExists(world.repoB, imported.snapshot));
      assert.isNotNull(imported.branch);
      assert.strictEqual(
        (yield* git(world.repoB, "rev-parse", imported.branch!)).trim(),
        (yield* git(world.repoA, "rev-parse", "HEAD")).trim(),
      );
      assert.deepStrictEqual(yield* repoState(world.repoB), before);
      assert.deepStrictEqual(yield* checkoutFiles(world.repoB), files);
    }).pipe(Effect.provide(destinationLayer(world, source.client, state)));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.live(
  "a thread working in the destination holds the working tree back, unless it is the caller",
  () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      yield* write(world.repoA, "tracked.txt", "edited on a\n");
      const source = yield* makeSource(world);
      const state: DestinationState = {
        working: [
          { id: CALLER, activeRun: true },
          { id: OTHER, activeRun: true },
        ],
        imports: [],
      };

      yield* Effect.gen(function* () {
        const receiver = yield* MachineReceiver.MachineReceiver;
        const blocked = yield* receiver.receive(request({ callerThreadId: CALLER }));
        assert.strictEqual(blocked.workingTree?.action, "refs-only");
        assert.strictEqual(blocked.workingTree?.reason, "checkout-busy");
        assert.strictEqual(yield* read(world.repoB, "tracked.txt"), "one\n");

        state.working.splice(1);
        const applied = yield* receiver.receive(request({ callerThreadId: CALLER }));
        assert.strictEqual(applied.workingTree?.action, "applied");
        assert.strictEqual(yield* read(world.repoB, "tracked.txt"), "edited on a\n");
      }).pipe(Effect.provide(destinationLayer(world, source.client, state)));
    }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.live("returns a running report at once and the finished one when asked again", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld();
    yield* write(world.repoA, "tracked.txt", "edited on a\n");
    const gate = yield* Deferred.make<void>();
    const source = yield* makeSource(world, { gate });
    const state: DestinationState = { working: [], imports: [] };

    yield* Effect.gen(function* () {
      const receiver = yield* MachineReceiver.MachineReceiver;
      const running = yield* receiver.receive(request({ waitMs: 0 }));
      assert.strictEqual(running.status, "running");
      yield* Deferred.succeed(gate, undefined);
      const finished = yield* receiver.receive(request({ transferId: running.transferId }));
      assert.strictEqual(finished.transferId, running.transferId);
      assert.strictEqual(finished.status, "completed");
      assert.strictEqual(finished.workingTree?.action, "applied");
      assert.strictEqual(source.calls.prepares, 1);
    }).pipe(Effect.provide(destinationLayer(world, source.client, state)));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.live("a damaged download fails the transfer and leaves the destination alone", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld();
    yield* write(world.repoA, "tracked.txt", "edited on a\n");
    const before = yield* repoState(world.repoB);
    const files = yield* checkoutFiles(world.repoB);
    const source = yield* makeSource(world, { corrupt: true });
    const state: DestinationState = { working: [], imports: [] };

    yield* Effect.gen(function* () {
      const receiver = yield* MachineReceiver.MachineReceiver;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const report = yield* receiver.receive(request());
      assert.strictEqual(report.status, "failed");
      assert.include(report.error ?? "", "arrived damaged");
      assert.isNull(report.workingTree);
      assert.deepStrictEqual(yield* repoState(world.repoB), before);
      assert.deepStrictEqual(yield* checkoutFiles(world.repoB), files);
      assert.isFalse(
        yield* refExists(world.repoB, `refs/t3/machines/snapshots/safety.${report.transferId}`),
      );
      const transferDir = path.join(stateDir, "machines", "incoming", report.transferId);
      assert.isFalse(yield* fileSystem.exists(path.join(transferDir, "files")));
      assert.isTrue(yield* fileSystem.exists(path.join(transferDir, "report.json")));
      assert.deepStrictEqual(source.calls.releases, [report.transferId]);
    }).pipe(Effect.provide(destinationLayer(world, source.client, state)));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.live("places rewritten transcripts and reports each session's thread", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld();
    yield* writeSession(world, SESSION);
    yield* writeSession(world, OWNED_SESSION);
    const source = yield* makeSource(world, { busySessions: [BUSY_SESSION] });
    const state: DestinationState = { working: [], imports: [] };

    yield* Effect.gen(function* () {
      const receiver = yield* MachineReceiver.MachineReceiver;
      const sql = yield* SqlClient.SqlClient;
      const path = yield* Path.Path;
      const ownedPayload = `{"nativeThreadRef":{"driver":"claudeAgent","nativeId":"${OWNED_SESSION}","strength":"strong"}}`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_threads
          (provider_thread_id, thread_id, provider, status, updated_at, payload_json, driver, provider_instance_id)
        VALUES ('provider-thread-other', ${OTHER}, 'claudeAgent', 'idle', '2026-11-13T00:00:00.000Z',
          ${ownedPayload}, 'claudeAgent', 'claudeAgent')
      `;

      const report = yield* receiver.receive(
        request({
          workingTree: "none",
          sessionIds: [SESSION, OWNED_SESSION, BUSY_SESSION],
        }),
      );

      assert.strictEqual(report.status, "completed");
      assert.isNull(report.workingTree);
      assert.deepStrictEqual(
        report.sessions.map(({ sessionId, threadId, status }) => ({ sessionId, threadId, status })),
        [
          { sessionId: SESSION, threadId: `import:claudeAgent:${SESSION}`, status: "imported" },
          { sessionId: OWNED_SESSION, threadId: OTHER, status: "conflict" },
          { sessionId: BUSY_SESSION, threadId: null, status: "busy" },
        ],
      );

      const projectDir = path.join(world.configB, "projects", claudeProjectDirName(world.repoB));
      const transcript = (yield* read(projectDir, `${SESSION}.jsonl`)) ?? "";
      assert.include(transcript, `"cwd":"${world.repoB}"`);
      assert.include(transcript, `${world.repoB}/tracked.txt`);
      assert.notInclude(transcript, world.repoA);
      assert.include(
        (yield* read(projectDir, `${SESSION}/subagents/agent-1.jsonl`)) ?? "",
        world.repoB,
      );
      assert.isNull(yield* read(projectDir, `${OWNED_SESSION}.jsonl`));
      assert.deepStrictEqual(state.imports, [
        {
          projectId: DESTINATION_PROJECT,
          expectedWorkspaceRoot: world.repoB,
          transcripts: [
            {
              providerInstanceId: "claudeAgent",
              filePath: path.join(projectDir, `${SESSION}.jsonl`),
            },
          ],
        },
      ]);
    }).pipe(Effect.provide(destinationLayer(world, source.client, state)));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);
