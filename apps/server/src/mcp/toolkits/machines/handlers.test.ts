import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MachineTransferReport,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as MachineLocalImport from "../../../machines/MachineLocalImport.ts";
import * as MachineReceiver from "../../../machines/MachineReceiver.ts";
import * as MachineSource from "../../../machines/MachineSource.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as MachinesHandlers from "./handlers.ts";
import { MachinesToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:machines");
const sourceEnvironmentId = EnvironmentId.make("environment:source");
const threadId = ThreadId.make("thread:machines");

const report: MachineTransferReport = {
  transferId: "t-1",
  status: "running",
  phase: "fetching",
  sourceEnvironmentId,
  destination: { projectId: ProjectId.make("project:dest"), root: "/dest" },
  workingTree: null,
  sessions: [],
  undo: { available: false, undoneAt: null },
  error: null,
};

const handle = Effect.fn("test.handle")(function* (
  name: "t3_machines_receive" | "t3_machines_undo",
  params: object,
) {
  const toolkit = yield* MachinesToolkit;
  const results = yield* Stream.runCollect(Stream.unwrap(toolkit.handle(name, params as never)));
  return results.at(-1)?.result;
});

const run = <A, E, R>(
  receiver: Partial<MachineReceiver.MachineReceiver["Service"]>,
  body: Effect.Effect<A, E, R>,
) =>
  body.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(MachinesHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ThreadCommandExecutor.layer,
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId,
              requestNamespace: "provider:machines",
              thread: {
                threadId,
                providerSessionId: "provider:machines",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
              client: undefined,
              capabilities: new Set(["orchestration" as const]),
              issuedAt: 0,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
            }),
            Layer.mock(MachineSource.MachineSource)({}),
            Layer.mock(MachineReceiver.MachineReceiver)(receiver),
            Layer.mock(MachineLocalImport.MachineLocalImport)({}),
          ),
        ),
      ),
    ),
  );

it.effect("receive with only a transferId reads the report", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const result = yield* run(
      {
        report: (input) =>
          Ref.update(calls, (all) => [...all, `report:${input.transferId}:${input.waitMs}`]).pipe(
            Effect.as(report),
          ),
        receive: () => Effect.die("receive must not start a transfer"),
      },
      handle("t3_machines_receive", { transferId: "t-1" }),
    );
    expect(result).toMatchObject({ transferId: "t-1" });
    expect(yield* Ref.get(calls)).toEqual(["report:t-1:45000"]);
  }),
);

it.effect("receive passes the caller thread and a 45 s wait", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<unknown>(undefined);
    yield* run(
      { receive: (input) => Ref.set(seen, input).pipe(Effect.as(report)) },
      handle("t3_machines_receive", {
        sourceEnvironmentId,
        sourceProjectId: "project:source",
        workingTree: "refs-only",
      }),
    );
    expect(yield* Ref.get(seen)).toEqual({
      sourceEnvironmentId,
      sourceProjectId: "project:source",
      workingTree: "refs-only",
      callerThreadId: threadId,
      waitMs: 45_000,
    });
  }),
);

it.effect("receive refuses missing source fields", () =>
  Effect.gen(function* () {
    const result = yield* run(
      { receive: () => Effect.die("unreachable") },
      handle("t3_machines_receive", { workingTree: "auto" }),
    );
    expect(result).toMatchObject({ code: "invalid_request" });
  }),
);

it.effect("maps machine errors to MCP failures", () =>
  Effect.gen(function* () {
    const [preflight, missing] = yield* run(
      {
        receive: () =>
          Effect.fail(
            new MachineReceiver.MachineSourceUnavailableError({
              environmentId: sourceEnvironmentId,
              linkReason: "disabled",
              status: null,
              cause: null,
            }),
          ),
        undo: () =>
          Effect.fail(new MachineSource.MachineTransferNotFoundError({ transferId: "t-9" })),
      },
      Effect.all([
        handle("t3_machines_receive", { sourceEnvironmentId, sourceProjectId: "project:source" }),
        handle("t3_machines_undo", { transferId: "t-9" }),
      ]),
    );
    expect(preflight).toMatchObject({
      code: "orchestration_error",
      message: expect.stringContaining("Linked environments is off"),
    });
    expect(missing).toMatchObject({
      code: "invalid_request",
      message: "Transfer t-9 was not found.",
    });
  }),
);
