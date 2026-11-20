import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { MachineReceiveInput } from "./machines.ts";

export const MachinePlanId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^mp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
);
export type MachinePlanId = typeof MachinePlanId.Type;

export const MachinePlanStepId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(40),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
export type MachinePlanStepId = typeof MachinePlanStepId.Type;

export const MachinePlanStepStatus = Schema.Literals([
  "proposed",
  "approved",
  "declined",
  "running",
  "done",
  "failed",
  "skipped",
  "undone",
  "not-run",
]);
export type MachinePlanStepStatus = typeof MachinePlanStepStatus.Type;

/** Config categories a `copy-config` step may write; MCP and settings entries become plan notes. */
export const MachinePlanCopyableCategory = Schema.Literals([
  "instructions",
  "rule",
  "agent",
  "command",
  "output-style",
  "memory",
  "skill",
]);
export type MachinePlanCopyableCategory = typeof MachinePlanCopyableCategory.Type;

export const MachinePlanReceiveInput = Schema.Struct({
  /** Null receives on this machine; otherwise the linked machine that receives. */
  destinationEnvironmentId: Schema.NullOr(EnvironmentId),
  receive: MachineReceiveInput,
});
export type MachinePlanReceiveInput = typeof MachinePlanReceiveInput.Type;

export const MachinePlanCloneProjectInput = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceProjectId: ProjectId,
  /** Absolute path on this machine for the new checkout. */
  destinationPath: TrimmedNonEmptyString,
});
export type MachinePlanCloneProjectInput = typeof MachinePlanCloneProjectInput.Type;

export const MachinePlanCopyConfigInput = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  /** `MachineConfigItem.id` on the source machine. */
  itemId: TrimmedNonEmptyString,
});
export type MachinePlanCopyConfigInput = typeof MachinePlanCopyConfigInput.Type;

const draftFields = {
  id: MachinePlanStepId,
  dependsOn: Schema.Array(MachinePlanStepId),
};

/** A step as the agent proposes it; the server resolves everything else. */
export const MachinePlanStepDraft = Schema.Union([
  Schema.Struct({
    ...draftFields,
    type: Schema.Literal("receive"),
    input: MachinePlanReceiveInput,
  }),
  Schema.Struct({
    ...draftFields,
    type: Schema.Literal("clone-project"),
    input: MachinePlanCloneProjectInput,
  }),
  Schema.Struct({
    ...draftFields,
    type: Schema.Literal("copy-config"),
    input: MachinePlanCopyConfigInput,
  }),
]);
export type MachinePlanStepDraft = typeof MachinePlanStepDraft.Type;

export const MachinePlanStepResult = Schema.Struct({
  finishedAt: IsoDateTime,
  /** Server-written and bounded: never file contents, tokens or env values. */
  message: Schema.String,
  transferId: Schema.optionalKey(TrimmedNonEmptyString),
  projectId: Schema.optionalKey(ProjectId),
  /** For copy-config: whether the destination existed, so undo restores or deletes. */
  replacedExisting: Schema.optionalKey(Schema.Boolean),
});
export type MachinePlanStepResult = typeof MachinePlanStepResult.Type;

const stepFields = {
  ...draftFields,
  /** Written by the server from the resolved input; the agent's wording is never shown. */
  summary: Schema.String,
  undoable: Schema.Boolean,
  status: MachinePlanStepStatus,
  result: Schema.NullOr(MachinePlanStepResult),
};

export const MachinePlanStep = Schema.Union([
  Schema.Struct({ ...stepFields, type: Schema.Literal("receive"), input: MachinePlanReceiveInput }),
  Schema.Struct({
    ...stepFields,
    type: Schema.Literal("clone-project"),
    input: MachinePlanCloneProjectInput,
    preconditions: Schema.Struct({ remoteUrl: TrimmedNonEmptyString }),
  }),
  Schema.Struct({
    ...stepFields,
    type: Schema.Literal("copy-config"),
    input: MachinePlanCopyConfigInput,
    /** For a skill, both hashes are directory digests and `destinationPath` is its folder. */
    preconditions: Schema.Struct({
      category: MachinePlanCopyableCategory,
      sourceSha256: Schema.String,
      destinationPath: TrimmedNonEmptyString,
      /** Null when the destination did not exist at proposal time. */
      destinationSha256: Schema.NullOr(Schema.String),
    }),
  }),
]);
export type MachinePlanStep = typeof MachinePlanStep.Type;

export const MachinePlan = Schema.Struct({
  id: MachinePlanId,
  /** Null when an MCP client outside a T3 thread proposed it. */
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  title: TrimmedNonEmptyString,
  notes: Schema.Array(Schema.String),
  steps: Schema.Array(MachinePlanStep),
});
export type MachinePlan = typeof MachinePlan.Type;
