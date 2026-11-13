import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MACHINE_TRANSFER_ROUTE_PREFIX,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AuthMcpClientAccess,
  type MachineConfigItem,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerHttp from "../http.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { claudeProjectDirName } from "./ClaudeTranscriptPortability.ts";
import * as ConfigInventory from "./ConfigInventory.ts";
import * as MachineSource from "./MachineSource.ts";
import * as MachinesHttp from "./MachinesHttp.ts";
import * as WorkingTreeSnapshot from "./WorkingTreeSnapshot.ts";

const PROJECT_ID = ProjectId.make("project-http");
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const TRANSCRIPT = `${JSON.stringify({ type: "user", cwd: "/somewhere", message: { content: "Hi" } })}\n`;

const layerPlatform = VcsDriverRegistry.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const makeFixture = Effect.fn("test.makeFixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* (yield* VcsDriverRegistry.VcsDriverRegistry).get("git");
  const run = (cwd: string, ...args: ReadonlyArray<string>) =>
    git.execute({ operation: "test.git", cwd, args });
  const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-machines-http-" });
  const repo = path.join(base, "repo");
  const claudeDir = path.join(base, "claude");
  yield* fileSystem.makeDirectory(repo);
  yield* run(repo, "init", "-q", "-b", "main");
  yield* run(repo, "config", "user.name", "Test");
  yield* run(repo, "config", "user.email", "test@test.com");
  yield* fileSystem.writeFileString(path.join(repo, "README.md"), "hello\n");
  yield* run(repo, "add", "-A");
  yield* run(repo, "commit", "-q", "-m", "initial");
  yield* fileSystem.writeFileString(path.join(repo, "README.md"), "hello, edited\n");
  const projectDir = path.join(claudeDir, "projects", claudeProjectDirName(repo));
  yield* fileSystem.makeDirectory(projectDir, { recursive: true });
  yield* fileSystem.writeFileString(path.join(projectDir, `${SESSION_ID}.jsonl`), TRANSCRIPT);
  return { repo, claudeDir };
});

const project = (root: string): OrchestrationProjectShell => ({
  id: PROJECT_ID,
  title: "Http project",
  workspaceRoot: root,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const configItem = {
  scope: "user",
  name: "style",
  path: "/claude/rules/style.md",
  project: null,
  sizeBytes: 5,
  sha256: "abc",
  modifiedAt: null,
} as const;
const RULE: MachineConfigItem = { ...configItem, id: "rule:user:style.md", category: "rule" };
const MCP: MachineConfigItem = {
  ...configItem,
  id: "mcp-server:user:db",
  category: "mcp-server",
  mcpScope: "user",
  transport: "stdio",
  command: "node",
};
const RULE_CONTENT = {
  id: RULE.id,
  path: RULE.path,
  content: "hello",
  sizeBytes: 5,
  sha256: "abc",
};

const readItemCalls: Array<string> = [];

const layerServices = (fixture: Effect.Success<ReturnType<typeof makeFixture>>) =>
  Layer.mergeAll(MachineSource.layer, EnvironmentAuth.layer).pipe(
    Layer.provideMerge(WorkingTreeSnapshot.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-http")),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          getShell: (projectId) =>
            Effect.succeed(
              projectId === PROJECT_ID ? Option.some(project(fixture.repo)) : Option.none(),
            ),
        }),
        ServerSettings.layerTest({
          linkedEnvironmentsEnabled: true,
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: fixture.claudeDir },
            },
          },
        }),
        Sqlite.layerMemory,
        ServerSecretStore.layer,
        ManagedPolicy.layerTest(),
        Layer.mock(ConfigInventory.ConfigInventory)({
          scan: () =>
            Effect.succeed({
              environmentId: EnvironmentId.make("environment-http"),
              scannedAt: "2026-01-01T00:00:00.000Z",
              homeDir: "/home",
              claudeConfigDir: "/claude",
              claudeVersion: null,
              items: [RULE, MCP],
              problems: [],
            }),
          readItem: (id) => {
            readItemCalls.push(id);
            return Effect.succeed(RULE_CONTENT);
          },
        }),
      ),
    ),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-machines-http-" })),
  );

const transferBody = (transferId: string) =>
  HttpBody.jsonUnsafe({
    transferId,
    sourceProjectId: PROJECT_ID,
    sessionIds: [SESSION_ID],
    workingTree: true,
    haves: [],
  });

const issueToken = (access: AuthMcpClientAccess, peerLink: boolean) =>
  Effect.flatMap(EnvironmentAuth.EnvironmentAuth, (auth) =>
    auth.issueMcpClientSession({
      label: `${access} ${peerLink ? "link" : "client"}`,
      access,
      peerLink,
      client: { deviceType: "bot" },
    }),
  );

const withRoutes = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    return yield* Effect.gen(function* () {
      yield* HttpRouter.serve(
        // No wait, so the first POST answers 202; compression as in server.ts.
        MachinesHttp.makeRoutes({ prepareWaitMs: 0 }).pipe(
          Layer.provide(ServerHttp.layerHttpCompression),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);
      return yield* effect;
    }).pipe(
      Effect.provide(layerServices(fixture).pipe(Layer.provideMerge(NodeHttpServer.layerTest))),
    );
  });

const client = (token: string) =>
  Effect.map(HttpClient.HttpClient, (httpClient) =>
    httpClient.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(token))),
  );

const identityPath = `${MACHINE_TRANSFER_ROUTE_PREFIX}/projects/${PROJECT_ID}/identity`;

it.layer(layerPlatform)("MachinesHttp", (it) => {
  it.effect("admits only linked environments with write access", () =>
    withRoutes(
      Effect.gen(function* () {
        const link = yield* issueToken("full-access", true);
        const response = yield* (yield* client(link.token)).get(identityPath);
        expect(response.status).toBe(200);
        expect(((yield* response.json) as { projectId: string }).projectId).toBe(PROJECT_ID);

        const browser = yield* Effect.flatMap(EnvironmentAuth.EnvironmentAuth, (auth) =>
          auth.issueSession(),
        );
        const refusals = [
          [(yield* issueToken("full-access", false)).token, 403],
          [(yield* issueToken("read-only", true)).token, 403],
          [browser.token, 401],
          ["not-a-token", 401],
        ] as const;
        for (const [token, status] of refusals) {
          expect((yield* (yield* client(token)).get(identityPath)).status).toBe(status);
        }

        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ linkedEnvironmentsEnabled: false });
        const off = yield* (yield* client(link.token)).get(identityPath);
        expect(off.status).toBe(403);
        expect(((yield* off.json) as { error: string }).error).toBe("linked_environments_off");
      }),
    ),
  );

  it.effect("serves a config item, its content only for readable categories", () =>
    withRoutes(
      Effect.gen(function* () {
        const link = yield* issueToken("full-access", true);
        const http = yield* client(link.token);
        const items = `${MACHINE_TRANSFER_ROUTE_PREFIX}/config/items`;
        readItemCalls.length = 0;

        const rule = yield* http.get(items, { urlParams: { id: RULE.id } });
        expect(rule.status).toBe(200);
        expect(yield* rule.json).toEqual({ item: RULE, content: RULE_CONTENT });

        const mcp = yield* http.get(items, { urlParams: { id: MCP.id } });
        expect(mcp.status).toBe(200);
        expect(yield* mcp.json).toEqual({ item: MCP, content: null });
        expect(readItemCalls).toEqual([RULE.id]);

        expect((yield* http.get(items, { urlParams: { id: "rule:user:nope" } })).status).toBe(404);
        expect((yield* http.get(items)).status).toBe(400);
      }),
    ),
  );

  it.effect("prepares, serves resumable files to their requester only, and releases", () =>
    withRoutes(
      Effect.gen(function* () {
        const link = yield* issueToken("full-access", true);
        const other = yield* issueToken("full-access", true);
        const http = yield* client(link.token);
        const transfers = `${MACHINE_TRANSFER_ROUTE_PREFIX}/transfers`;

        const preparing = yield* http.post(transfers, { body: transferBody("t-http") });
        expect(preparing.status).toBe(202);
        expect(yield* preparing.json).toEqual({ status: "preparing" });
        // Await the job the POST started, as a re-POST eventually would.
        const source = yield* MachineSource.MachineSource;
        yield* source.prepareTransfer({
          transferId: "t-http",
          sourceProjectId: PROJECT_ID,
          sessionIds: [SESSION_ID],
          workingTree: true,
          haves: [],
          requesterSessionId: link.sessionId,
          waitMs: 60_000,
        });
        const ready = yield* http.post(transfers, { body: transferBody("t-http") });
        expect(ready.status).toBe(200);
        const manifest = (yield* ready.json) as {
          files: ReadonlyArray<{ index: number; kind: string; sizeBytes: number }>;
        };
        const session = manifest.files.find((file) => file.kind === "session")!;
        expect(session.sizeBytes).toBe(TRANSCRIPT.length);

        const fileUrl = `${transfers}/t-http/files/${session.index}`;
        const whole = yield* http.get(fileUrl, { headers: { "accept-encoding": "gzip" } });
        expect(whole.status).toBe(200);
        expect(whole.headers["content-encoding"]).toBeUndefined();
        expect(yield* whole.text).toBe(TRANSCRIPT);
        const tail = yield* http.get(fileUrl, { headers: { range: "bytes=10-" } });
        expect(tail.status).toBe(206);
        expect(tail.headers["content-range"]).toBe(
          `bytes 10-${TRANSCRIPT.length - 1}/${TRANSCRIPT.length}`,
        );
        expect(yield* tail.text).toBe(TRANSCRIPT.slice(10));

        const stranger = yield* client(other.token);
        expect((yield* stranger.get(fileUrl)).status).toBe(404);
        expect((yield* stranger.del(`${transfers}/t-http`)).status).toBe(404);
        expect((yield* http.del(`${transfers}/t-http`)).status).toBe(204);
        expect((yield* http.get(fileUrl)).status).toBe(404);
      }),
    ),
  );
});
