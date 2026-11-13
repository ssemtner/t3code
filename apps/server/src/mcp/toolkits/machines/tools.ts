import {
  MachineReceiveInput,
  MachineSurvey,
  MachineSurveyInput,
  MachineTransferReport,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as MachineReceiver from "../../../machines/MachineReceiver.ts";
import * as MachineSource from "../../../machines/MachineSource.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    MachineSource.MachineSource,
    MachineReceiver.MachineReceiver,
  ],
};
const MachinesSurveyTool = Tool.make("t3_machines_survey", {
  ...shared,
  description:
    "Projects here (or on a linked machine) with git checkout state and recent Claude sessions that worked in each, including sessions started in another folder. Read-only.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...MachineSurveyInput.fields,
  }),
  success: MachineSurvey,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const MachinesReceiveTool = Tool.make("t3_machines_receive", {
  ...shared,
  description:
    "Copy a project's uncommitted work and/or Claude sessions from linked machine sourceEnvironmentId to this machine. Sessions become threads here that resume the same conversation. Changes are applied only when this checkout is on the same commit with no conflicting edits; otherwise they are imported as git refs and the result says why. If status is running, call again with only transferId.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...MachineReceiveInput.fields,
    sourceEnvironmentId: Schema.optionalKey(MachineReceiveInput.fields.sourceEnvironmentId),
    sourceProjectId: Schema.optionalKey(MachineReceiveInput.fields.sourceProjectId),
  }),
  success: MachineTransferReport,
}).annotate(Tool.Destructive, true);
const MachinesUndoTool = Tool.make("t3_machines_undo", {
  ...shared,
  description:
    "Restore the working tree a receive changed, from its safety snapshot. Imported threads stay.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    transferId: TrimmedNonEmptyString,
  }),
  success: MachineTransferReport,
}).annotate(Tool.Destructive, true);

export const MachinesToolkit = Toolkit.make(
  MachinesSurveyTool,
  MachinesReceiveTool,
  MachinesUndoTool,
);
