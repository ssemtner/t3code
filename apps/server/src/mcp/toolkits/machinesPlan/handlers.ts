import { type MachinePlan, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MachinePlanRunner from "../../../machines/assistant/MachinePlanRunner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MachinesPlanToolkit } from "./tools.ts";

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const mapError = (error: { readonly _tag: string; readonly message: string }) => {
  switch (error._tag) {
    case "MachinePlanInvalidError":
    case "MachinePlanNotFoundError":
      return failure("invalid_request", error.message);
    case "MachinePlanApprovalUnavailableError":
      return failure("capability_denied", error.message);
    case "MachinePlanReadError":
    case "MachinePlanWriteError":
      return failure("orchestration_error", error.message);
    default:
      return failure("orchestration_error", "The operation could not be completed.");
  }
};

const renderPlan = (plan: MachinePlan) =>
  [
    `Plan ${plan.id}: ${plan.title}`,
    ...plan.steps.flatMap((step, index) => [
      `${index + 1}. [${step.status}] ${step.summary}${step.dependsOn.length === 0 ? "" : ` (after ${step.dependsOn.join(", ")})`}`,
      ...(step.result === null ? [] : [`   ${step.result.message}`]),
    ]),
    ...(plan.notes.length === 0
      ? []
      : ["For the user to do by hand:", ...plan.notes.map((note) => `- ${note}`)]),
  ].join("\n");

const view = (plan: MachinePlan) => ({ plan, summary: renderPlan(plan) });

const scope = McpInvocationContext.McpInvocationContext;

const callerThreadId = Effect.map(scope, (current) => current.thread?.threadId);

// assertNotLinked lets full-access links through; plans are only for this machine's own agents.
const refuseLinked = Effect.flatMap(scope, (current) =>
  current.client?.linked === true
    ? Effect.fail(
        failure("capability_denied", "A linked environment cannot use machine plans here."),
      )
    : Effect.void,
);

const runOutcome = (outcome: MachinePlanRunner.MachinePlanRunOutcome) =>
  outcome._tag === "InputRequired"
    ? { inputRequests: { ...outcome.inputRequired.inputRequests } }
    : { ...view(outcome.plan), cancelled: outcome.cancelled };

export const layer = McpToolAccess.toLayer(MachinesPlanToolkit, {
  t3_machines_plan_propose: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      yield* refuseLinked;
      const runner = yield* MachinePlanRunner.MachinePlanRunner;
      const plan = yield* runner
        .propose({
          threadId: (yield* callerThreadId) ?? null,
          title: input.title,
          notes: input.notes ?? [],
          steps: input.steps,
        })
        .pipe(Effect.mapError(mapError));
      return view(plan);
    }),
  ),
  t3_machines_plan_status: McpToolAccess.reads(({ planId }) =>
    Effect.gen(function* () {
      yield* refuseLinked;
      const runner = yield* MachinePlanRunner.MachinePlanRunner;
      return view(yield* runner.status(planId).pipe(Effect.mapError(mapError)));
    }),
  ),
  t3_machines_plan_execute: McpToolAccess.writesEnvironment(({ planId, stepIds }) =>
    Effect.gen(function* () {
      yield* refuseLinked;
      const runner = yield* MachinePlanRunner.MachinePlanRunner;
      const outcome = yield* runner
        .execute({ planId, stepIds, callerThreadId: yield* callerThreadId })
        .pipe(Effect.mapError(mapError));
      return runOutcome(outcome);
    }),
  ),
  t3_machines_plan_undo: McpToolAccess.writesEnvironment(({ planId, stepId }) =>
    Effect.gen(function* () {
      yield* refuseLinked;
      const runner = yield* MachinePlanRunner.MachinePlanRunner;
      const outcome = yield* runner
        .undo({ planId, stepId, callerThreadId: yield* callerThreadId })
        .pipe(Effect.mapError(mapError));
      return runOutcome(outcome);
    }),
  ),
});
