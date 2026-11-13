import { NodeHttpServer } from "@effect/platform-node";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MACHINE_TRANSFER_ROUTE_PREFIX,
  type OrchestrationProjectShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { HttpRouter, HttpServer } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { claudeProjectDirName } from "./ClaudeTranscriptPortability.ts";
import * as ConfigInventory from "./ConfigInventory.ts";
import * as MachinePeerClient from "./MachinePeerClient.ts";
import * as MachineReceiver from "./MachineReceiver.ts";
import * as MachineSource from "./MachineSource.ts";
import * as MachinesHttp from "./MachinesHttp.ts";
import * as WorkingTreeSnapshot from "./WorkingTreeSnapshot.ts";

const SOURCE_ENVIRONMENT = EnvironmentId.make("env-source");
const SOURCE_PROJECT = ProjectId.make("project-source");
const DESTINATION_PROJECT = ProjectId.make("project-destination");
const SESSION = "4e8f5c1e-3d2a-4f6b-9c1d-2e3f4a5b6c7d";
const CLAUDE = ProviderInstanceId.make("claudeAgent");

const layerPlatform = WorkingTreeSnapshot.layer.pipe(
  Layer.provideMerge(VcsDriverRegistry.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
);

const git = Effect.fn("test.git")(function* (cwd: string, ...args: ReadonlyArray<string>) {
  const driver = yield* (yield* VcsDriverRegistry.VcsDriverRegistry).get("git");
  return (yield* driver.execute({ operation: "test.git", cwd, args })).stdout;
});

const write = Effect.fn("test.write")(function* (cwd: string, file: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(path.join(cwd, file)), { recursive: true });
  yield* fileSystem.writeFileString(path.join(cwd, file), contents);
});

const tempDirectory = Effect.fn("test.tempDirectory")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  // Git reports real paths, and macOS temp dirs sit behind a symlink.
  return yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-machines-e2e-" }),
  );
});

/** Two machines: clones of one origin, each with its own home and Claude config dir. */
const makeWorld = Effect.fn("test.makeWorld")(function* () {
  const path = yield* Path.Path;
  const origin = yield* tempDirectory();
  const clone = Effect.fn("test.clone")(function* () {
    const cwd = yield* tempDirectory();
    yield* git(cwd, "clone", "-q", origin, ".");
    yield* git(cwd, "config", "user.name", "Test");
    yield* git(cwd, "config", "user.email", "test@test.com");
    return cwd;
  });
  yield* git(origin, "init", "-q", "-b", "main");
  yield* git(origin, "config", "user.name", "Test");
  yield* git(origin, "config", "user.email", "test@test.com");
  yield* write(origin, "tracked.txt", "one\n");
  yield* git(origin, "add", "-A");
  yield* git(origin, "commit", "-q", "-m", "initial");
  const homeA = yield* tempDirectory();
  const homeB = yield* tempDirectory();
  return {
    repoA: yield* clone(),
    repoB: yield* clone(),
    homeA,
    homeB,
    configA: path.join(homeA, ".claude"),
    configB: path.join(homeB, ".claude"),
  };
});
type World = Effect.Success<ReturnType<typeof makeWorld>>;

const shell = (id: ProjectId, root: string): OrchestrationProjectShell => ({
  id,
  title: "Project",
  workspaceRoot: root,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

const claudeSettings = (configDir: string) =>
  ServerSettings.layerTest({
    linkedEnvironmentsEnabled: true,
    providerInstances: {
      [CLAUDE]: { driver: ProviderDriverKind.make("claudeAgent"), config: { homePath: configDir } },
    },
  });

const sourceLayer = (world: World) =>
  Layer.mergeAll(MachineSource.layer, EnvironmentAuth.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(SOURCE_ENVIRONMENT),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          getShell: (projectId) =>
            Effect.succeed(
              projectId === SOURCE_PROJECT
                ? Option.some(shell(SOURCE_PROJECT, world.repoA))
                : Option.none(),
            ),
        }),
        claudeSettings(world.configA),
        Sqlite.layerMemory,
        ServerSecretStore.layer,
        ManagedPolicy.layerTest(),
        Layer.mock(ConfigInventory.ConfigInventory)({}),
        Layer.succeed(HostProcess.HomeDirectory, world.homeA),
      ),
    ),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-machines-e2e-a-" })),
    Layer.provideMerge(NodeHttpServer.layerTest),
  );

interface Exchange {
  readonly method: string;
  readonly path: string;
  readonly range: string | null;
  readonly status: number;
}

/** Real fetch, except the first full download of `cutPath` stops halfway, as a dropped link would. */
const recordingFetch = (exchanges: Array<Exchange>, cutPath: string) => {
  let cut = false;
  return async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    // @effect-diagnostics-next-line globalFetch:off -- this is the transport FetchHttpClient calls.
    const response = await fetch(request);
    const path = new URL(request.url).pathname;
    const range = request.headers.get("range");
    exchanges.push({ method: request.method, path, range, status: response.status });
    if (cut || path !== cutPath || range !== null) return response;
    cut = true;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return new Response(bytes.subarray(0, Math.floor(bytes.length / 2)), {
      status: response.status,
      headers: response.headers,
    });
  };
};

const destinationLayer = (
  world: World,
  link: { readonly url: string; readonly token: string },
  fetchImpl: typeof globalThis.fetch,
  imports: Array<unknown>,
) =>
  MachineReceiver.layer.pipe(
    Layer.provideMerge(MachinePeerClient.layerHttp),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(PeerLinks.PeerLinks)({
          enabled: Effect.succeed(true),
          resolve: (environmentId) =>
            Effect.succeed({
              link: {
                environmentId,
                label: "Source",
                urls: [link.url],
                access: "approval-required",
                linkedAt: DateTime.makeUnsafe(0),
                expiresAt: DateTime.makeUnsafe(Date.UTC(2100, 0)),
                lastReachedAt: null,
                lastError: null,
              },
              url: link.url,
              token: link.token,
            }),
          recordOutcome: () => Effect.void,
        }),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImpl))),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([shell(DESTINATION_PROJECT, world.repoB)]),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          listActiveShellIndex: () => Effect.succeed([]),
        }),
        Layer.mock(AgentSessionImporter.AgentSessionImporter)({
          importSessionTranscripts: (input) =>
            Effect.sync(() => {
              imports.push(input);
              return { importedCount: 1, skippedCount: 0 };
            }),
        }),
        claudeSettings(world.configB),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-machines-e2e-b-" }),
        Layer.fresh(Sqlite.layerMemory),
        Layer.succeed(HostProcess.HomeDirectory, world.homeB),
      ),
    ),
  );

it.live("moves uncommitted work and a Claude session from one machine to another", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const world = yield* makeWorld();
    yield* write(world.repoA, "tracked.txt", "edited on a\n");
    yield* write(world.repoA, "new.txt", "new on a\n");
    const sourceDir = path.join(world.configA, "projects", claudeProjectDirName(world.repoA));
    const transcript = Array.from({ length: 200 }, (_, index) =>
      JSON.stringify({
        type: index % 2 === 0 ? "user" : "assistant",
        cwd: world.repoA,
        sessionId: SESSION,
        message: { role: "user", content: `Edit ${world.repoA}/tracked.txt, step ${index}` },
      }),
    ).join("\n");
    yield* write(sourceDir, `${SESSION}.jsonl`, `${transcript}\n`);

    // Machine A: the peer routes on a real socket, and a link token it issued.
    const source = yield* Layer.build(sourceLayer(world));
    const link = yield* Effect.gen(function* () {
      // No wait, so the first prepare answers 202 and the client must ask again.
      yield* HttpRouter.serve(MachinesHttp.makeRoutes({ prepareWaitMs: 0 }), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const server = yield* HttpServer.HttpServer;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const session = yield* auth.issueMcpClientSession({
        label: "machine b",
        access: "full-access",
        peerLink: true,
        client: { deviceType: "bot" },
      });
      return { url: HttpServer.formatAddress(server.address), token: session.token };
    }).pipe(Effect.provideContext(source));

    // Machine B: the receiver, reaching A only through the HTTP peer client.
    const exchanges: Array<Exchange> = [];
    // File 0 is the bundle; file 1 is the session's transcript, dropped halfway through.
    const transcriptPath = `${MACHINE_TRANSFER_ROUTE_PREFIX}/transfers/t-e2e/files/1`;
    const imports: Array<unknown> = [];
    const report = yield* Effect.gen(function* () {
      const receiver = yield* MachineReceiver.MachineReceiver;
      const transferId = "t-e2e";
      const result = yield* receiver.receive({
        transferId,
        sourceEnvironmentId: SOURCE_ENVIRONMENT,
        sourceProjectId: SOURCE_PROJECT,
        sessionIds: [SESSION],
        workingTree: "auto",
        waitMs: 10 * 60_000,
      });
      assert.deepStrictEqual(yield* receiver.report({ transferId, waitMs: 0 }), result);
      // A refusal carries the source's machine-readable reason.
      const refused = yield* (yield* MachinePeerClient.MachinePeerClient)
        .identity(SOURCE_ENVIRONMENT, { projectId: "project-missing" })
        .pipe(Effect.flip);
      assert.deepInclude(refused, { status: 404, code: "project_not_found" });
      return result;
    }).pipe(
      Effect.provide(
        destinationLayer(world, link, recordingFetch(exchanges, transcriptPath), imports),
      ),
    );

    assert.strictEqual(report.status, "completed", report.error ?? undefined);

    // Prepare: asked again after 202 until the manifest was ready.
    const prepares = exchanges.filter((exchange) => exchange.method === "POST");
    assert.strictEqual(prepares[0]?.status, 202);
    assert.strictEqual(prepares.at(-1)?.status, 200);

    // The dropped download resumed from where it stopped.
    const resumed = exchanges.find((exchange) => exchange.range !== null);
    assert.strictEqual(resumed?.path, transcriptPath);
    assert.match(resumed?.range ?? "", /^bytes=[1-9]\d*-$/);
    assert.strictEqual(resumed?.status, 206);

    // Working tree applied, with a safety snapshot to undo it.
    assert.strictEqual(report.workingTree?.action, "applied");
    const safetyRef = "refs/t3/machines/snapshots/safety.t-e2e";
    assert.strictEqual(report.workingTree?.safetyRef, safetyRef);
    assert.isNotEmpty(yield* git(world.repoB, "rev-parse", "--verify", safetyRef));
    assert.strictEqual(
      yield* fileSystem.readFileString(path.join(world.repoB, "tracked.txt")),
      "edited on a\n",
    );
    assert.strictEqual(
      yield* fileSystem.readFileString(path.join(world.repoB, "new.txt")),
      "new on a\n",
    );

    // The session placed under B's project dir with A's paths rewritten to B's.
    assert.deepStrictEqual(
      report.sessions.map((session) => [session.sessionId, session.status]),
      [[SESSION, "imported"]],
    );
    const placed = yield* fileSystem.readFileString(
      path.join(world.configB, "projects", claudeProjectDirName(world.repoB), `${SESSION}.jsonl`),
    );
    assert.notInclude(placed, world.repoA);
    assert.include(placed, `${world.repoB}/tracked.txt`);
    assert.strictEqual(imports.length, 1);

    // The source was released: its staged files are gone.
    const releases = exchanges.filter((exchange) => exchange.method === "DELETE");
    assert.deepStrictEqual(
      releases.map((exchange) => exchange.status),
      [204],
    );
  }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
);
