// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test recomputes staged hashes independently.
import * as NodeCrypto from "node:crypto";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type MachineTransferRequest,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { claudeProjectDirName } from "./ClaudeTranscriptPortability.ts";
import * as MachineSource from "./MachineSource.ts";
import * as WorkingTreeSnapshot from "./WorkingTreeSnapshot.ts";

const PROJECT_ID = ProjectId.make("project-source");
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const REQUESTER = "session-requester";

const layerPlatform = VcsDriverRegistry.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCryptoLayer.layer)),
);

const git = Effect.fn("test.git")(function* (cwd: string, ...args: ReadonlyArray<string>) {
  const driver = yield* (yield* VcsDriverRegistry.VcsDriverRegistry).get("git");
  return (yield* driver.execute({ operation: "test.git", cwd, args })).stdout;
});

const write = Effect.fn("test.write")(function* (file: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
  yield* fileSystem.writeFileString(file, contents);
});

const transcriptLine = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;

/** A repo with a commit, an uncommitted edit and an untracked file, plus a Claude config dir. */
const makeFixture = Effect.fn("test.makeFixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-machine-source-" });
  const repo = path.join(base, "repo");
  const claudeDir = path.join(base, "claude");
  yield* fileSystem.makeDirectory(repo, { recursive: true });
  yield* git(repo, "init", "-q", "-b", "main");
  yield* git(repo, "config", "user.name", "Test");
  yield* git(repo, "config", "user.email", "test@test.com");
  yield* write(path.join(repo, "README.md"), "hello\n");
  yield* git(repo, "add", "-A");
  yield* git(repo, "commit", "-q", "-m", "initial");
  yield* write(path.join(repo, "README.md"), "hello, edited\n");
  yield* write(path.join(repo, "notes.txt"), "untracked\n");

  // Session A ran in the repo but is filed under another directory's name.
  const elsewhere = path.join(
    claudeDir,
    "projects",
    claudeProjectDirName(path.join(base, "other")),
  );
  yield* write(
    path.join(elsewhere, `${SESSION_A}.jsonl`),
    transcriptLine({
      type: "user",
      cwd: repo,
      timestamp: "2026-11-01T00:00:00.000Z",
      message: { role: "user", content: "Fix the flaky test" },
    }) +
      transcriptLine({
        type: "assistant",
        cwd: repo,
        timestamp: "2026-11-01T00:01:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", input: { file_path: path.join(repo, "README.md") } }],
        },
      }),
  );
  yield* write(path.join(elsewhere, SESSION_A, "subagents", "agent-1.jsonl"), "{}\n");
  const filedHere = path.join(claudeDir, "projects", claudeProjectDirName(repo));
  yield* write(
    path.join(filedHere, `${SESSION_B}.jsonl`),
    transcriptLine({
      type: "user",
      cwd: repo,
      timestamp: "2026-11-02T00:00:00.000Z",
      message: { role: "user", content: "Second session" },
    }),
  );
  return { base, repo, claudeDir };
});

type Fixture = Effect.Success<ReturnType<typeof makeFixture>>;

const project = (root: string): OrchestrationProjectShell => ({
  id: PROJECT_ID,
  title: "Source project",
  workspaceRoot: root,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

interface SnapshotProbe {
  snapshots: number;
  readonly gate?: Deferred.Deferred<void>;
}

// The real snapshot service, counting snapshots and optionally holding them until a gate opens.
const layerProbedSnapshot = (probe: SnapshotProbe) =>
  Layer.effect(
    WorkingTreeSnapshot.WorkingTreeSnapshot,
    Effect.gen(function* () {
      const real = yield* WorkingTreeSnapshot.WorkingTreeSnapshot;
      return WorkingTreeSnapshot.WorkingTreeSnapshot.of({
        ...real,
        snapshotWorkingTree: (cwd, snapshotId) =>
          Effect.sync(() => {
            probe.snapshots += 1;
          }).pipe(
            Effect.andThen(probe.gate === undefined ? Effect.void : Deferred.await(probe.gate)),
            Effect.andThen(real.snapshotWorkingTree(cwd, snapshotId)),
          ),
      });
    }),
  ).pipe(Layer.provide(WorkingTreeSnapshot.layer));

const layerSource = (fixture: Fixture, probe: SnapshotProbe) =>
  MachineSource.layer.pipe(
    Layer.provideMerge(layerProbedSnapshot(probe)),
    Layer.provideMerge(
      Layer.mergeAll(
        ServerConfig.layerTest(fixture.repo, fixture.base),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-source")),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([project(fixture.repo)]),
          getShell: (projectId) =>
            Effect.succeed(
              projectId === PROJECT_ID ? Option.some(project(fixture.repo)) : Option.none(),
            ),
        }),
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: fixture.claudeDir },
            },
          },
        }),
        SqlitePersistence.layerMemory,
      ),
    ),
  );

const withSource = <A, E, R>(
  fixture: Fixture,
  probe: SnapshotProbe,
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.provide(layerSource(fixture, probe)));

const request = (
  transferId: string,
  overrides: Partial<
    MachineTransferRequest & { readonly requesterSessionId: string; readonly waitMs: number }
  > = {},
) => ({
  transferId,
  sourceProjectId: PROJECT_ID,
  sessionIds: [SESSION_A],
  workingTree: true,
  haves: [],
  requesterSessionId: REQUESTER,
  waitMs: 60_000,
  ...overrides,
});

const prepareReady = Effect.fn("test.prepareReady")(function* (input: ReturnType<typeof request>) {
  const source = yield* MachineSource.MachineSource;
  const result = yield* source.prepareTransfer(input);
  assert.strictEqual(result.status, "ready");
  if (result.status !== "ready") throw new Error("unreachable");
  return result.manifest;
});

const ownSession = Effect.fn("test.ownSession")(function* (
  sessionId: string,
  runStatus: string | null,
  pendingBackgroundTasks: ReadonlyArray<{ taskId: string; kind: string }> = [],
) {
  const sql = yield* SqlClient.SqlClient;
  const threadId = `import:claudeAgent:${sessionId}`;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    ) VALUES (
      ${threadId}, ${PROJECT_ID}, 'Owned', 'claudeAgent', 'full-access', 'default',
      '2026-01-01', '2026-01-01', '{}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_threads (
      provider_thread_id, thread_id, provider, status, updated_at, payload_json,
      driver, provider_instance_id
    ) VALUES (
      ${`provider-${sessionId}`}, ${threadId}, 'claudeAgent', 'idle', '2026-01-01',
      ${JSON.stringify({
        nativeThreadRef: { driver: "claudeAgent", nativeId: sessionId },
        pendingBackgroundTasks,
      })},
      'claudeAgent', 'claudeAgent'
    )
  `;
  if (runStatus !== null) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      ) VALUES (${`run-${sessionId}`}, ${threadId}, 1, 'claudeAgent', ${runStatus}, '2026-01-01', '{}')
    `;
  }
  return threadId;
});

const transferDir = (transferId: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    return path.join(stateDir, "machines", "outgoing", transferId);
  });

const exists = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.exists(file));

const snapshotRef = (fixture: Fixture, transferId: string) =>
  Effect.flatMap(WorkingTreeSnapshot.WorkingTreeSnapshot, (snapshots) =>
    snapshots.readRef(fixture.repo, `refs/t3/machines/snapshots/${transferId}`),
  );

it.layer(layerPlatform)("MachineSource", (it) => {
  it.effect("survey finds sessions filed under another project directory", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* withSource(
        fixture,
        { snapshots: 0 },
        Effect.gen(function* () {
          const ownerThreadId = yield* ownSession(SESSION_B, null);
          const source = yield* MachineSource.MachineSource;
          const survey = yield* source.survey({});
          assert.strictEqual(survey.environmentId, "environment-source");
          const [surveyed] = survey.projects;
          assert.strictEqual(surveyed?.checkoutError, null);
          assert.isNotNull(surveyed?.checkout ?? null);
          const sessions = new Map(
            surveyed!.sessions.map((session) => [session.sessionId, session]),
          );
          assert.strictEqual(sessions.get(SESSION_A)?.filedElsewhere, true);
          assert.strictEqual(sessions.get(SESSION_A)?.title, "Fix the flaky test");
          assert.deepStrictEqual(sessions.get(SESSION_A)?.roots, [
            { root: fixture.repo, cwdLines: 2, toolPaths: 1 },
          ]);
          assert.strictEqual(sessions.get(SESSION_A)?.existingThreadId, null);
          assert.strictEqual(sessions.get(SESSION_B)?.filedElsewhere, false);
          assert.strictEqual(sessions.get(SESSION_B)?.existingThreadId, ownerThreadId);
        }),
      );
    }),
  );

  it.effect("describes the project's own worktrees and refuses other paths", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const path = yield* Path.Path;
      const worktree = path.join(fixture.base, "feature");
      yield* git(fixture.repo, "worktree", "add", "-q", "-b", "feature", worktree);
      yield* withSource(
        fixture,
        { snapshots: 0 },
        Effect.gen(function* () {
          const source = yield* MachineSource.MachineSource;
          const identity = yield* source.describeCheckout({
            projectId: PROJECT_ID,
            worktreePath: worktree,
          });
          assert.strictEqual(identity.branch, "feature");
          assert.strictEqual(identity.projectRoot, fixture.repo);
          const outside = yield* source
            .describeCheckout({ projectId: PROJECT_ID, worktreePath: fixture.claudeDir })
            .pipe(Effect.flip);
          assert.strictEqual(outside._tag, "MachineWorktreeNotFoundError");
          const unknown = yield* source
            .describeCheckout({ projectId: ProjectId.make("project-unknown") })
            .pipe(Effect.flip);
          assert.strictEqual(unknown._tag, "MachineProjectNotFoundError");
        }),
      );
    }),
  );

  it.effect("stages the bundle and session files, hashed, and reuses the manifest", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const fileSystem = yield* FileSystem.FileSystem;
      const probe: SnapshotProbe = { snapshots: 0 };
      yield* withSource(
        fixture,
        probe,
        Effect.gen(function* () {
          const source = yield* MachineSource.MachineSource;
          const manifest = yield* prepareReady(request("t-stage"));
          assert.deepStrictEqual(
            manifest.files.map((file) => [file.index, file.kind, file.relativePath ?? null]),
            [
              [0, "bundle", null],
              [1, "session", `${SESSION_A}.jsonl`],
              [2, "session", `${SESSION_A}/subagents/agent-1.jsonl`],
            ],
          );
          for (const file of manifest.files) {
            const staged = yield* source.openStagedFile({
              transferId: "t-stage",
              fileIndex: file.index,
              requesterSessionId: REQUESTER,
            });
            const bytes = yield* fileSystem.readFile(staged.path);
            assert.strictEqual(bytes.byteLength, file.sizeBytes);
            assert.strictEqual(
              NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
              file.sha256,
            );
          }
          assert.deepStrictEqual(manifest.sessions, [
            { sessionId: SESSION_A, title: "Fix the flaky test", status: "staged" },
          ]);
          assert.strictEqual(manifest.checkout?.branchRef, "refs/heads/main");
          assert.deepStrictEqual(
            manifest.checkout?.description.entries.map((entry) => [entry.path, entry.kind]),
            [
              ["README.md", "modified"],
              ["notes.txt", "untracked"],
            ],
          );
          assert.strictEqual(
            yield* snapshotRef(fixture, "t-stage"),
            manifest.checkout?.snapshotCommit,
          );

          const again = yield* prepareReady(request("t-stage", { waitMs: 0 }));
          assert.deepStrictEqual(again, manifest);
          assert.strictEqual(probe.snapshots, 1);
        }),
      );
    }),
  );

  it.effect("answers preparing until the job finishes and writes the manifest last", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const path = yield* Path.Path;
      const probe: SnapshotProbe = { snapshots: 0, gate: yield* Deferred.make<void>() };
      yield* withSource(
        fixture,
        probe,
        Effect.gen(function* () {
          const source = yield* MachineSource.MachineSource;
          const first = yield* source.prepareTransfer(request("t-wait", { waitMs: 0 }));
          assert.deepStrictEqual(first, { status: "preparing" });
          const directory = yield* transferDir("t-wait");
          assert.isTrue(yield* exists(path.join(directory, "request.json")));
          assert.isFalse(yield* exists(path.join(directory, "manifest.json")));
          const notReady = yield* source
            .openStagedFile({ transferId: "t-wait", fileIndex: 0, requesterSessionId: REQUESTER })
            .pipe(Effect.flip);
          assert.strictEqual(notReady._tag, "MachineTransferNotFoundError");

          yield* Deferred.succeed(probe.gate!, undefined);
          const manifest = yield* prepareReady(request("t-wait"));
          assert.strictEqual(manifest.transferId, "t-wait");
          assert.isTrue(yield* exists(path.join(directory, "manifest.json")));
          assert.strictEqual(probe.snapshots, 1);
        }),
      );
    }),
  );

  it.effect("reports a session whose thread runs or has background work as busy", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* withSource(
        fixture,
        { snapshots: 0 },
        Effect.gen(function* () {
          yield* ownSession(SESSION_A, "running");
          yield* ownSession("background-session", "completed", [
            { taskId: "task-1", kind: "command" },
          ]);
          const manifest = yield* prepareReady(
            request("t-busy", {
              sessionIds: [SESSION_A, SESSION_B, "missing-session", "background-session"],
            }),
          );
          assert.deepStrictEqual(
            manifest.sessions.map((session) => [session.sessionId, session.status]),
            [
              [SESSION_A, "busy"],
              [SESSION_B, "staged"],
              ["missing-session", "missing"],
              ["background-session", "busy"],
            ],
          );
          assert.isFalse(manifest.files.some((file) => file.sessionId === SESSION_A));
        }),
      );
    }),
  );

  it.effect("refuses other requesters and releases staged files and the snapshot ref", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* withSource(
        fixture,
        { snapshots: 0 },
        Effect.gen(function* () {
          const source = yield* MachineSource.MachineSource;
          yield* prepareReady(request("t-release"));
          const other = { transferId: "t-release", requesterSessionId: "session-other" };
          const conflict = yield* source
            .prepareTransfer(request("t-release", { requesterSessionId: "session-other" }))
            .pipe(Effect.flip);
          assert.strictEqual(conflict._tag, "MachineTransferConflictError");
          const open = yield* source.openStagedFile({ ...other, fileIndex: 0 }).pipe(Effect.flip);
          assert.strictEqual(open._tag, "MachineTransferNotFoundError");
          const release = yield* source.releaseTransfer(other).pipe(Effect.flip);
          assert.strictEqual(release._tag, "MachineTransferNotFoundError");

          const directory = yield* transferDir("t-release");
          assert.isTrue(yield* exists(directory));
          yield* source.releaseTransfer({ transferId: "t-release", requesterSessionId: REQUESTER });
          assert.isFalse(yield* exists(directory));
          assert.strictEqual(yield* snapshotRef(fixture, "t-release"), null);
        }),
      );
    }),
  );

  it.effect("sweeps transfers staged more than an hour ago", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* withSource(
        fixture,
        { snapshots: 0 },
        Effect.gen(function* () {
          const source = yield* MachineSource.MachineSource;
          yield* prepareReady(request("t-old"));
          yield* TestClock.adjust("30 minutes");
          yield* prepareReady(request("t-young"));
          yield* TestClock.adjust("31 minutes");
          yield* source.sweepOutgoing;

          assert.isFalse(yield* exists(yield* transferDir("t-old")));
          assert.strictEqual(yield* snapshotRef(fixture, "t-old"), null);
          assert.isTrue(yield* exists(yield* transferDir("t-young")));
          assert.isNotNull(yield* snapshotRef(fixture, "t-young"));
        }),
      );
    }),
  );
});
