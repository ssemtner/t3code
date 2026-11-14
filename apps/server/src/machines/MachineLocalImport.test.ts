import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { claudeProjectDirName } from "./ClaudeTranscriptPortability.ts";
import * as MachineLocalImport from "./MachineLocalImport.ts";

const PROJECT = ProjectId.make("project-local");
const OTHER = ThreadId.make("thread-other");
const SESSION = "0b8f5c1e-3d2a-4f6b-9c1d-2e3f4a5b6c7d";
const OWNED_SESSION = "1c8f5c1e-3d2a-4f6b-9c1d-2e3f4a5b6c7d";
const IMPORTED_SESSION = "2d8f5c1e-3d2a-4f6b-9c1d-2e3f4a5b6c7d";

const baseLayer = VcsDriverRegistry.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.merge(NodeServices.layer, NodePlatformCrypto.layer)),
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

const read = Effect.fn("test.read")(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return (yield* fileSystem.exists(file)) ? yield* fileSystem.readFileString(file) : null;
});

const jsonl = (...records: ReadonlyArray<unknown>) =>
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

/** One repository with a worktree beside it, and a Claude config dir. */
const makeWorld = Effect.fn("test.makeWorld")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Git reports real paths, and macOS temp dirs sit behind a symlink.
  const base = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-machines-local-import-" }),
  );
  const root = path.join(base, "repo");
  const worktree = path.join(base, "repo-feature");
  yield* fileSystem.makeDirectory(root);
  yield* git(root, "init", "-q", "-b", "main");
  yield* git(root, "config", "user.name", "Test");
  yield* git(root, "config", "user.email", "test@test.com");
  yield* write(path.join(root, "tracked.txt"), "one\n");
  yield* git(root, "add", "-A");
  yield* git(root, "commit", "-q", "-m", "initial");
  yield* git(root, "worktree", "add", "-q", "-b", "feature", worktree);
  const configDir = path.join(base, ".claude");
  return {
    root,
    worktree,
    configDir,
    projectDir: (cwd: string) => path.join(configDir, "projects", claudeProjectDirName(cwd)),
  };
});
type World = Effect.Success<ReturnType<typeof makeWorld>>;

const writeSession = Effect.fn("test.writeSession")(function* (
  world: World,
  sessionId: string,
  cwd: string,
) {
  const dir = world.projectDir(cwd);
  const transcript = jsonl(
    {
      type: "user",
      cwd,
      sessionId,
      timestamp: "2026-11-13T10:00:00.000Z",
      message: { role: "user", content: "Fix the tracked file" },
    },
    {
      type: "assistant",
      cwd,
      sessionId,
      timestamp: "2026-11-13T10:00:05.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Read", input: { file_path: `${cwd}/tracked.txt` } }],
      },
    },
  );
  yield* write(`${dir}/${sessionId}.jsonl`, transcript);
  yield* write(
    `${dir}/${sessionId}/subagents/agent-1.jsonl`,
    jsonl({ type: "user", cwd, message: { role: "user", content: "Look around" } }),
  );
  return transcript;
});

const testLayer = (world: World, imports: Array<unknown>) =>
  MachineLocalImport.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          getShell: (projectId) =>
            Effect.succeed(
              projectId === PROJECT
                ? Option.some({
                    id: PROJECT,
                    title: "Project",
                    workspaceRoot: world.root,
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: "2026-11-01T00:00:00.000Z",
                    updatedAt: "2026-11-01T00:00:00.000Z",
                  })
                : Option.none(),
            ),
        }),
        Layer.mock(AgentSessionImporter.AgentSessionImporter)({
          importSessionTranscripts: (input) =>
            Effect.sync(() => {
              imports.push(input);
              return { importedCount: 1, skippedCount: 0 };
            }),
        }),
        ServerSettings.ServerSettingsService.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: world.configDir },
            },
          },
        }),
        Layer.fresh(SqlitePersistence.layerMemory),
      ),
    ),
  );

const ownSession = Effect.fn("test.ownSession")(function* (threadId: string, sessionId: string) {
  const sql = yield* SqlClient.SqlClient;
  const payload = `{"nativeThreadRef":{"driver":"claudeAgent","nativeId":"${sessionId}","strength":"strong"}}`;
  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, provider, status, updated_at, payload_json, driver, provider_instance_id)
    VALUES (${`provider-${threadId}`}, ${threadId}, 'claudeAgent', 'idle', '2026-11-13T00:00:00.000Z',
      ${payload}, 'claudeAgent', 'claudeAgent')
  `;
});

it.live("opens a session filed under the project as a thread where it is", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld();
    const transcript = yield* writeSession(world, SESSION, world.root);
    const imports: Array<unknown> = [];

    yield* Effect.gen(function* () {
      const localImport = yield* MachineLocalImport.MachineLocalImport;
      const result = yield* localImport.importSessions({
        projectId: PROJECT,
        sessionIds: [SESSION],
      });
      assert.deepStrictEqual(result, {
        projectId: PROJECT,
        sessions: [
          {
            sessionId: SESSION,
            threadId: ThreadId.make(`import:claudeAgent:${SESSION}`),
            status: "imported",
          },
        ],
      });
      assert.deepStrictEqual(imports, [
        {
          projectId: PROJECT,
          expectedWorkspaceRoot: world.root,
          transcripts: [
            {
              providerInstanceId: "claudeAgent",
              filePath: `${world.projectDir(world.root)}/${SESSION}.jsonl`,
            },
          ],
        },
      ]);
      assert.strictEqual(
        yield* read(`${world.projectDir(world.root)}/${SESSION}.jsonl`),
        transcript,
      );
    }).pipe(Effect.provide(testLayer(world, imports)));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.live("copies a session from a worktree with its paths mapped and leaves the original", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld();
    const original = yield* writeSession(world, SESSION, world.worktree);
    const originalPath = `${world.projectDir(world.worktree)}/${SESSION}.jsonl`;
    const imports: Array<unknown> = [];

    yield* Effect.gen(function* () {
      const localImport = yield* MachineLocalImport.MachineLocalImport;
      const result = yield* localImport.importSessions({
        projectId: PROJECT,
        sessionIds: [SESSION],
      });
      assert.deepStrictEqual(
        result.sessions.map(({ status, threadId }) => ({ status, threadId })),
        [{ status: "imported", threadId: ThreadId.make(`import:claudeAgent:${SESSION}`) }],
      );
      const copied = (yield* read(`${world.projectDir(world.root)}/${SESSION}.jsonl`)) ?? "";
      assert.include(copied, `"cwd":"${world.root}"`);
      assert.include(copied, `${world.root}/tracked.txt`);
      assert.notInclude(copied, world.worktree);
      assert.include(
        (yield* read(`${world.projectDir(world.root)}/${SESSION}/subagents/agent-1.jsonl`)) ?? "",
        world.root,
      );
      assert.strictEqual(yield* read(originalPath), original);
      assert.lengthOf(imports, 1);
    }).pipe(Effect.provide(testLayer(world, imports)));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.live("reports sessions that are already threads and ids it cannot find", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld();
    yield* writeSession(world, OWNED_SESSION, world.worktree);
    yield* writeSession(world, IMPORTED_SESSION, world.root);
    const imports: Array<unknown> = [];

    yield* Effect.gen(function* () {
      yield* ownSession(OTHER, OWNED_SESSION);
      yield* ownSession(`import:claudeAgent:${IMPORTED_SESSION}`, IMPORTED_SESSION);
      const localImport = yield* MachineLocalImport.MachineLocalImport;
      const missing = "3e8f5c1e-3d2a-4f6b-9c1d-2e3f4a5b6c7d";
      const result = yield* localImport.importSessions({
        projectId: PROJECT,
        sessionIds: [OWNED_SESSION, IMPORTED_SESSION, missing, "../escape"],
      });
      assert.deepStrictEqual(result.sessions, [
        { sessionId: OWNED_SESSION, threadId: OTHER, status: "existing-thread" },
        {
          sessionId: IMPORTED_SESSION,
          threadId: ThreadId.make(`import:claudeAgent:${IMPORTED_SESSION}`),
          status: "existing-thread",
        },
        { sessionId: missing, threadId: null, status: "not-found" },
        { sessionId: "../escape", threadId: null, status: "not-found" },
      ]);
      // A session another thread continues is neither copied nor imported again.
      assert.isNull(yield* read(`${world.projectDir(world.root)}/${OWNED_SESSION}.jsonl`));
      assert.lengthOf(imports, 1);

      const unknownProject = yield* localImport
        .importSessions({ projectId: ProjectId.make("nope"), sessionIds: [SESSION] })
        .pipe(Effect.flip);
      assert.strictEqual(unknownProject._tag, "MachineProjectNotFoundError");
    }).pipe(Effect.provide(testLayer(world, imports)));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.each([
  {
    name: "a subfolder of the project's checkout keeps its paths",
    sessionCwd: "/repo/packages/app",
    sessionCheckoutRoot: "/repo",
    expected: [{ from: "/c/projects/-repo-packages-app", to: "/c/projects/-repo" }],
  },
  {
    name: "a worktree maps onto the project's checkout",
    sessionCwd: "/wt/packages/app",
    sessionCheckoutRoot: "/wt",
    expected: [
      { from: "/c/projects/-repo-packages-app", to: "/c/projects/-repo" },
      { from: "/wt", to: "/repo" },
    ],
  },
  {
    name: "a folder that is gone maps itself onto the project",
    sessionCwd: "/old/place",
    sessionCheckoutRoot: null,
    expected: [
      { from: "/c/projects/-repo-packages-app", to: "/c/projects/-repo" },
      { from: "/old/place", to: "/repo" },
    ],
  },
])("localTranscriptMappings: $name", ({ sessionCwd, sessionCheckoutRoot, expected }) => {
  assert.deepStrictEqual(
    MachineLocalImport.localTranscriptMappings({
      sessionCwd,
      sessionCheckoutRoot,
      projectRoot: "/repo",
      projectCheckoutRoot: sessionCheckoutRoot === null ? null : "/repo",
      sourceProjectDir: "/c/projects/-repo-packages-app",
      destinationProjectDir: "/c/projects/-repo",
    }),
    expected,
  );
});
