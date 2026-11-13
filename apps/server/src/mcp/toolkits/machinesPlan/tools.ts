import {
  MachinePlan,
  MachinePlanStepDraft,
  MachinePlanStepId,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as MachinePlanRunner from "../../../machines/assistant/MachinePlanRunner.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  MachinePlanRunner.MachinePlanRunner,
];

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies,
};

const PlanResult = Schema.Struct({
  plan: MachinePlan,
  /** Server-rendered; show it to the user as is. */
  summary: Schema.String,
});

/**
 * The user's answers are pending. McpHttpServer turns this into an MCP input-required result;
 * the model never sees it.
 */
const PlanInputRequired = Schema.Struct({
  inputRequests: Schema.Record(Schema.String, Schema.Unknown),
});
export const isPlanInputRequired = Schema.is(PlanInputRequired);

const RunResult = Schema.Union([
  Schema.Struct({ ...PlanResult.fields, cancelled: Schema.Boolean }),
  PlanInputRequired,
]);

const PlanIdParameter = TrimmedNonEmptyString.annotate({
  description: "The plan id from t3_machines_plan_propose (mp-...).",
});

const approvalNote =
  "The user approves or declines each step in an approval card; you cannot approve for them, and no argument does.";

const ProposeTool = Tool.make("t3_machines_plan_propose", {
  ...shared,
  description:
    "Store a plan of steps that move work to or between linked machines: receive sessions/uncommitted work, clone a project, copy one Claude config file. Nothing runs yet. The server checks every step, writes its summary, and turns MCP servers, hooks, permissions, env vars and plugins into notes for the user. Show the returned summary to the user.",
  parameters: Schema.Struct({
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    steps: Schema.Array(MachinePlanStepDraft),
    notes: Schema.optionalKey(
      Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(20)),
    ),
  }),
  success: PlanResult,
}).annotate(Tool.Destructive, false);

const StatusTool = Tool.make("t3_machines_plan_status", {
  ...shared,
  description: "A stored plan with each step's status and result. Read-only.",
  parameters: Schema.Struct({ planId: PlanIdParameter }),
  success: PlanResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ExecuteTool = Tool.make("t3_machines_plan_execute", {
  ...shared,
  dependencies: [...dependencies, McpSchema.McpRequestContext],
  description: `Run a stored plan's steps in order, stopping at the first failure. ${approvalNote} A declined step and the steps that depend on it are skipped.`,
  parameters: Schema.Struct({
    planId: PlanIdParameter,
    stepIds: Schema.optionalKey(Schema.Array(MachinePlanStepId)),
  }),
  success: RunResult,
}).annotate(Tool.Destructive, true);

const UndoTool = Tool.make("t3_machines_plan_undo", {
  ...shared,
  dependencies: [...dependencies, McpSchema.McpRequestContext],
  description: `Undo one completed step, or every undoable completed step in reverse order. ${approvalNote}`,
  parameters: Schema.Struct({
    planId: PlanIdParameter,
    stepId: Schema.optionalKey(MachinePlanStepId),
  }),
  success: RunResult,
}).annotate(Tool.Destructive, true);

export const MachinesPlanToolkit = Toolkit.make(ProposeTool, StatusTool, ExecuteTool, UndoTool);

/** The tools whose results may ask the client for input. */
export const MACHINES_PLAN_INPUT_TOOLS: ReadonlySet<string> = new Set([
  ExecuteTool.name,
  UndoTool.name,
]);
