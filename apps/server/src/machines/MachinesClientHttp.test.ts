import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthSourceControlWriteScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentId,
  EnvironmentMachinesHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ConfigInventory from "./ConfigInventory.ts";
import * as MachineLocalImport from "./MachineLocalImport.ts";
import * as MachineReceiver from "./MachineReceiver.ts";
import * as MachinesClientHttp from "./MachinesClientHttp.ts";
import * as MachineSource from "./MachineSource.ts";
import * as MachineThreadMoves from "./MachineThreadMoves.ts";
import * as WorkingTreeSnapshot from "./WorkingTreeSnapshot.ts";

const serve = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("environment").add(EnvironmentMachinesHttpApi)).pipe(
      Layer.provide(MachinesClientHttp.layer),
      Layer.provide(
        Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
          effect.pipe(
            Effect.provideService(EnvironmentAuthenticatedPrincipal, {
              sessionId: AuthSessionId.make("machines-test"),
              subject: "test",
              method: "bearer-access-token",
              scopes: new Set(scopes),
            }),
          ),
        ),
      ),
      // Services left unimplemented die when called, so a guarded route that reached one fails with 500.
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(MachineSource.MachineSource)({}),
          Layer.mock(MachineReceiver.MachineReceiver)({
            receive: () =>
              Effect.fail(
                new MachineReceiver.MachineSourceUnavailableError({
                  environmentId: EnvironmentId.make("env-a"),
                  linkReason: "disabled",
                  status: null,
                  cause: null,
                }),
              ),
          }),
          Layer.mock(MachineLocalImport.MachineLocalImport)({}),
          Layer.mock(WorkingTreeSnapshot.WorkingTreeSnapshot)({}),
          Layer.mock(MachineThreadMoves.MachineThreadMoves)({}),
          Layer.mock(ConfigInventory.ConfigInventory)({}),
        ),
      ),
      Layer.provide(HttpServer.layerServices),
      Layer.provide(NodeServices.layer),
    ),
    { disableLogger: true },
  );

const call = Effect.fn("test.call")(function* (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  route: { readonly method: string; readonly path: string; readonly body?: unknown },
) {
  const { handler, dispose } = serve(scopes);
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  const context = yield* Layer.build(NodeServices.layer);
  const response = yield* Effect.promise(() =>
    handler(
      new Request(`http://localhost/api/machines/ui/${route.path}`, {
        method: route.method,
        ...(route.body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(route.body) }),
      }),
      context,
    ),
  );
  return { status: response.status, body: yield* Effect.promise(() => response.json()) };
});

const read = AuthOrchestrationReadScope;
const operate = AuthOrchestrationOperateScope;
const write = AuthSourceControlWriteScope;
const receiveBody = { sourceEnvironmentId: "env-a", sourceProjectId: "project-a" };

it.effect.each([
  { route: { method: "POST", path: "survey", body: {} }, granted: [], missing: read },
  {
    route: { method: "POST", path: "checkout", body: { projectId: "p" } },
    granted: [],
    missing: read,
  },
  {
    route: { method: "POST", path: "receive", body: receiveBody },
    granted: [read, write],
    missing: operate,
  },
  {
    route: { method: "POST", path: "receive", body: receiveBody },
    granted: [read, operate],
    missing: write,
    // Source control is granted under orchestration:operate, so the error names the permission.
    expected: { requiredScope: operate, requiredPermission: write },
  },
  {
    route: { method: "POST", path: "import-local", body: { projectId: "p", sessionIds: ["s"] } },
    granted: [read, write],
    missing: operate,
  },
  { route: { method: "GET", path: "transfers/t-1?wait=1" }, granted: [], missing: read },
  {
    route: { method: "POST", path: "transfers/t-1/undo" },
    granted: [read, operate],
    missing: write,
    // Source control is granted under orchestration:operate, so the error names the permission.
    expected: { requiredScope: operate, requiredPermission: write },
  },
  { route: { method: "GET", path: "threads/thread-1/move-source" }, granted: [], missing: read },
  {
    route: {
      method: "POST",
      path: "threads/thread-1/moved",
      body: { destinationEnvironmentId: "env-b", destinationThreadId: "t", transferId: "t-1" },
    },
    granted: [read],
    missing: operate,
  },
  { route: { method: "GET", path: "moves" }, granted: [], missing: read },
  { route: { method: "POST", path: "inventory", body: {} }, granted: [], missing: read },
] as const)("$route.method $route.path needs $missing", (row) =>
  Effect.gen(function* () {
    const { status, body } = yield* call(row.granted, row.route);
    expect(status).toBe(403);
    expect(body).toMatchObject({
      _tag: "EnvironmentScopeRequiredError",
      ...("expected" in row ? row.expected : { requiredScope: row.missing }),
    });
  }).pipe(Effect.scoped),
);

it.effect("refuses a receive while links are off with a code the client can act on", () =>
  Effect.gen(function* () {
    const { status, body } = yield* call([read, operate, write], {
      method: "POST",
      path: "receive",
      body: receiveBody,
    });
    expect(status).toBe(409);
    expect(body).toMatchObject({ _tag: "MachineRequestRefusedError", code: "links-disabled" });
  }).pipe(Effect.scoped),
);
