import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type MachineConfigItem,
  type MachinePlan,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as ServerConfig from "../../../config.ts";
import { ServerEnvironmentIdentity } from "../../../environment/ServerEnvironment.ts";
import * as MachineConfigApply from "../../../machines/assistant/MachineConfigApply.ts";
import * as MachinePlanApprover from "../../../machines/assistant/MachinePlanApprover.ts";
import * as MachinePlanRunner from "../../../machines/assistant/MachinePlanRunner.ts";
import * as MachinePlanStore from "../../../machines/assistant/MachinePlanStore.ts";
import * as MachinePeerClient from "../../../machines/MachinePeerClient.ts";
import * as MachineReceiver from "../../../machines/MachineReceiver.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as PeerMcpClient from "../../../peer/PeerMcpClient.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

const threadToken = "threadTokenWithoutDots";
const linkedToken = "linkedTokenWithoutDots";
const environmentId = EnvironmentId.make("environment:plan-tools");
const source = EnvironmentId.make("environment:source");
const threadId = ThreadId.make("thread:assistant");

const scopeFor = (linked: boolean): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: linked ? "client:linked" : "provider-session",
  thread: linked
    ? undefined
    : {
        threadId,
        providerSessionId: "provider-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
  client: linked
    ? { sessionId: "link-session", label: "Laptop", access: "full-access", linked: true }
    : undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

const agentItem = (id: string) =>
  ({
    id,
    category: "agent",
    scope: "user",
    name: id,
    path: `/source/${id}.md`,
    project: null,
    sizeBytes: 1,
    sha256: "x",
    modifiedAt: null,
    description: null,
  }) satisfies MachineConfigItem;

const serve = (writes: Ref.Ref<ReadonlyArray<string>>) =>
  Effect.gen(function* () {
    const runner = MachinePlanRunner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(environmentId),
          }),
          Layer.mock(PeerLinks.PeerLinks)({ get: () => Effect.succeedNone }),
          Layer.mock(MachinePeerClient.MachinePeerClient)({
            readConfigItem: (_environmentId, itemId) =>
              Effect.succeed({
                item: agentItem(itemId),
                content: {
                  id: itemId,
                  path: "/source",
                  content: itemId,
                  sizeBytes: 1,
                  sha256: "s",
                },
              }),
          }),
          Layer.mock(MachineConfigApply.MachineConfigApply)({
            destinationOf: (item) => Effect.succeed(`/dest/${item.id}`),
            payloadOf: (_item, content) =>
              Effect.succeed({
                kind: "file" as const,
                content: content.content,
                sha256: content.sha256,
              }),
            sha256Of: () => Effect.succeed(null),
            write: (input) =>
              Ref.update(writes, (all) => [...all, input.path]).pipe(
                Effect.as({ replacedExisting: false }),
              ),
          }),
          Layer.mock(MachineReceiver.MachineReceiver)({}),
          Layer.mock(PeerMcpClient.PeerMcpClient)({}),
          Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          MachinePlanApprover.layerElicitation,
          MachinePlanStore.layer.pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-plan-tools-" })),
          ),
        ),
      ),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    const layerServer = McpHttpServer.layerMcpTransport(
      McpHttpServer.layerMachinesPlanToolkit,
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          runner,
          ThreadCommandExecutor.layer,
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          }),
        ),
      ),
      Layer.provide(ServerSettings.layerTest({ linkedEnvironmentsEnabled: true })),
      Layer.provide(
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          resolve: (presented) =>
            Effect.succeed(
              presented === threadToken
                ? (scopeFor(false) as McpInvocationContext.McpThreadInvocationScope)
                : presented === linkedToken
                  ? (scopeFor(true) as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
            ),
        }),
      ),
    );
    yield* HttpRouter.serve(layerServer, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.build,
    );
    const httpClient = yield* HttpClient.HttpClient;
    return (token: string, name: string, args: object, params: object = {}) =>
      httpClient
        .pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(token)))
        .post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            "mcp-method": "tools/call",
            "mcp-name": name,
            "mcp-protocol-version": "2026-07-28",
          },
          body: HttpBody.text(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name,
                arguments: args,
                ...params,
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                  "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
                  "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "2.1.325" },
                },
              },
            }),
            "application/json",
          ),
        })
        .pipe(
          Effect.flatMap((response) => response.json),
          Effect.map((json) => json as unknown as CallResult),
        );
  });

interface CallResult {
  readonly result: {
    readonly resultType?: string;
    readonly inputRequests?: Record<string, { method: string; params: { message: string } }>;
    readonly structuredContent?: { plan?: MachinePlan; summary?: string };
    readonly isError?: boolean;
    readonly content?: ReadonlyArray<{ text?: string }>;
  };
}

it.effect("execute asks the user for every step; only the answers decide what runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const writes = yield* Ref.make<ReadonlyArray<string>>([]);
      const call = yield* serve(writes);
      const proposed = yield* call(threadToken, "t3_machines_plan_propose", {
        title: "Copy agents",
        steps: [
          {
            id: "a",
            dependsOn: [],
            type: "copy-config",
            input: { sourceEnvironmentId: source, itemId: "agent:user:a.md" },
          },
          {
            id: "b",
            dependsOn: [],
            type: "copy-config",
            input: { sourceEnvironmentId: source, itemId: "agent:user:b.md" },
          },
        ],
      });
      const planId = proposed.result.structuredContent?.plan?.id;
      expect(planId).toMatch(/^mp-/);

      // An "approved" argument from the model is refused outright and asks nothing.
      const forged = yield* call(threadToken, "t3_machines_plan_execute", {
        planId,
        approved: true,
      });
      expect(forged.result.isError).toBe(true);
      expect(forged.result.content?.[0]?.text).toContain('Unknown argument "approved"');

      const asked = yield* call(threadToken, "t3_machines_plan_execute", { planId });
      expect(asked.result.resultType).toBe("input_required");
      const requests = Object.entries(asked.result.inputRequests ?? {});
      expect(requests.map(([, request]) => request.params.message)).toEqual([
        expect.stringMatching(
          new RegExp(`^Plan ${planId}, step 1 of 2: Copy agent .*\\[[0-9a-f]{8}\\]$`),
        ),
        expect.stringMatching(
          new RegExp(`^Plan ${planId}, step 2 of 2: Copy agent .*\\[[0-9a-f]{8}\\]$`),
        ),
      ]);
      expect(yield* Ref.get(writes)).toEqual([]);

      const [firstKey, secondKey] = requests.map(([key]) => key);
      const ran = yield* call(
        threadToken,
        "t3_machines_plan_execute",
        { planId },
        {
          inputResponses: {
            [firstKey!]: { action: "accept", content: {} },
            [secondKey!]: { action: "decline" },
          },
        },
      );
      expect(ran.result.structuredContent?.plan?.steps.map((step) => step.status)).toEqual([
        "done",
        "declined",
      ]);
      expect(yield* Ref.get(writes)).toEqual(["/dest/agent:user:a.md"]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a linked environment cannot use plan tools", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const call = yield* serve(yield* Ref.make<ReadonlyArray<string>>([]));
      const refused = yield* call(linkedToken, "t3_machines_plan_status", {
        planId: "mp-00000000-0000-4000-8000-000000000001",
      });
      expect(refused.result.isError).toBe(true);
      expect(refused.result.content?.[0]?.text).toContain(
        "A linked environment cannot use machine plans",
      );
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
