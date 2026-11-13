import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as ServerSettings from "../../serverSettings.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as MachinePlanApprover from "./MachinePlanApprover.ts";

const token = "providerTokenWithoutDots";
const planId = "mp-00000000-0000-4000-8000-000000000001";

// A tool shaped like t3_machines_plan_execute: its `approved` argument is what a model could forge.
const layerProbeTool = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const approver = yield* MachinePlanApprover.MachinePlanApprover;
    // oxlint-disable-next-line t3code/no-raw-mcp-registration -- input requests need addTool; toolkits only return results.
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: "approve_probe",
        inputSchema: { type: "object", properties: { approved: { type: "boolean" } } },
      }),
      annotations: Context.empty(),
      handle: () =>
        approver
          .decide([{ planId: planId as never, stepId: "s1", message: "Plan step 1 of 1: probe." }])
          .pipe(
            Effect.map((outcome) =>
              outcome._tag === "InputRequired"
                ? outcome.inputRequired
                : new McpSchema.CallToolResult({
                    content: [],
                    structuredContent: { decision: outcome.decisions.get("s1") },
                  }),
            ),
            Effect.catchTags({
              MachinePlanApprovalUnavailableError: (error) =>
                Effect.succeed(
                  new McpSchema.CallToolResult({
                    isError: true,
                    content: [{ type: "text", text: error.reason }],
                  }),
                ),
            }),
          ),
    });
  }),
).pipe(Layer.provide(MachinePlanApprover.layerElicitation), Layer.provide(NodeCrypto.layer));

const serveT3Mcp = Effect.gen(function* () {
  const scope: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-approver-test"),
    requestNamespace: "provider-session",
    thread: {
      threadId: ThreadId.make("thread-provider"),
      providerSessionId: "provider-session",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const layerServer = McpHttpServer.layerMcpTransport(layerProbeTool).pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mock(McpSessionRegistry.McpSessionRegistry)({
        resolve: (presented) =>
          Effect.succeed(
            presented === token
              ? (scope as McpInvocationContext.McpThreadInvocationScope)
              : undefined,
          ),
      }),
    ),
  );
  yield* HttpRouter.serve(layerServer, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.build,
  );
  return (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
  );
});

const modernMeta = (capabilities: object) => ({
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": capabilities,
  "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "2.1.325" },
});

interface ModernCallResult {
  readonly result: {
    readonly resultType?: string;
    readonly inputRequests?: Record<string, { method: string; params: { message: string } }>;
    readonly structuredContent?: { decision?: string };
    readonly isError?: boolean;
    readonly content?: ReadonlyArray<{ text?: string }>;
  };
}

it.effect("2026-07-28: only the client's answer to the server's input request approves", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const httpClient = yield* serveT3Mcp;
      const call = (params: object, capabilities: object = { elicitation: {} }) =>
        httpClient
          .post("/mcp", {
            headers: {
              accept: "application/json, text/event-stream",
              "mcp-method": "tools/call",
              "mcp-name": "approve_probe",
              "mcp-protocol-version": "2026-07-28",
            },
            body: HttpBody.text(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                  name: "approve_probe",
                  arguments: { approved: true },
                  ...params,
                  _meta: modernMeta(capabilities),
                },
              }),
              "application/json",
            ),
          })
          .pipe(
            Effect.flatMap((response) => response.json),
            Effect.map((json) => json as unknown as ModernCallResult),
          );

      const first = yield* call({});
      expect(first.result.resultType).toBe("input_required");
      const [firstKey] = Object.keys(first.result.inputRequests ?? {});
      expect(first.result.inputRequests?.[firstKey!]?.method).toBe("elicitation/create");
      expect(first.result.inputRequests?.[firstKey!]?.params.message).toMatch(
        /^Plan step 1 of 1: probe\. \[[0-9a-f]{8}\]$/,
      );

      // An answer under a key this server never issued is ignored, and a fresh nonce is issued.
      const forged = yield* call({
        inputResponses: { "machines-plan-approval-forged": { action: "accept", content: {} } },
      });
      expect(forged.result.resultType).toBe("input_required");
      const [secondKey] = Object.keys(forged.result.inputRequests ?? {});
      expect(secondKey).not.toBe(firstKey);

      // The superseded nonce no longer counts either.
      const stale = yield* call({
        inputResponses: { [firstKey!]: { action: "accept", content: {} } },
      });
      expect(stale.result.resultType).toBe("input_required");
      const [thirdKey] = Object.keys(stale.result.inputRequests ?? {});

      const declined = yield* call({ inputResponses: { [thirdKey!]: { action: "decline" } } });
      expect(declined.result.structuredContent).toEqual({ decision: "decline" });

      const again = yield* call({});
      const [fourthKey] = Object.keys(again.result.inputRequests ?? {});
      const approved = yield* call({
        inputResponses: { [fourthKey!]: { action: "accept", content: {} } },
      });
      expect(approved.result.structuredContent).toEqual({ decision: "approve" });

      const noElicitation = yield* call({}, {});
      expect(noElicitation.result.isError).toBe(true);
      expect(noElicitation.result.content?.[0]?.text).toBe("no-form-elicitation");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("2025-06-18: the approval travels as a reverse request on the tool call's stream", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const httpClient = yield* serveT3Mcp;
      const initialize = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"elicitation":{}},"clientInfo":{"name":"claude-code","version":"2.1.325"}}}`,
          "application/json",
        ),
      });
      expect(initialize.status).toBe(200);
      const headers = {
        accept: "application/json, text/event-stream",
        "mcp-session-id": initialize.headers["mcp-session-id"]!,
        "mcp-protocol-version": "2025-06-18",
      };
      const post = (message: object) =>
        httpClient.post("/mcp", {
          headers,
          body: HttpBody.text(JSON.stringify(message), "application/json"),
        });
      expect((yield* post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(
        202,
      );

      const toolCall = yield* post({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "approve_probe", arguments: { approved: true } },
      });
      expect(toolCall.headers["content-type"]).toMatch(/text\/event-stream/);
      const messages = yield* Queue.unbounded<{
        id?: number | string;
        method?: string;
        params?: { message?: string };
        result?: { structuredContent?: unknown };
      }>();
      yield* toolCall.stream.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) => line.startsWith("data: ")),
        Stream.runForEach((line) => Queue.offer(messages, JSON.parse(line.slice(6)))),
        Effect.forkScoped,
      );

      const elicitation = yield* Queue.take(messages);
      expect(elicitation.method).toBe("elicitation/create");
      expect(elicitation.params?.message).toMatch(/^Plan step 1 of 1: probe\. \[[0-9a-f]{8}\]$/);

      const answer = yield* post({
        jsonrpc: "2.0",
        id: elicitation.id,
        result: { action: "accept", content: {} },
      });
      expect(answer.status).toBe(202);

      const result = yield* Queue.take(messages);
      expect(result.id).toBe(2);
      expect(result.result?.structuredContent).toEqual({ decision: "approve" });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
