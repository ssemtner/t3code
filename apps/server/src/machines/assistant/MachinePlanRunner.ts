import {
  CommandId,
  type EnvironmentId,
  type MachineConfigItem,
  MachinePlanCopyableCategory,
  type MachinePlan,
  type MachinePlanStep,
  type MachinePlanStepDraft,
  type MachinePlanStepResult,
  type MachinePlanStepStatus,
  MachineTransferReport,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { McpSchema } from "effect/ai";

import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as PeerMcpClient from "../../peer/PeerMcpClient.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as SourceControlRepositoryService from "../../sourceControl/SourceControlRepositoryService.ts";
import * as MachinePeerClient from "../MachinePeerClient.ts";
import * as MachineReceiver from "../MachineReceiver.ts";
import * as MachineConfigApply from "./MachineConfigApply.ts";
import * as MachinePlanApprover from "./MachinePlanApprover.ts";
import * as MachinePlanStore from "./MachinePlanStore.ts";

const MAX_STEPS = 20;
const MAX_MESSAGE = 500;
// A forwarded tool call that stays silent for about 100 s is dropped by T3 Connect.
const RECEIVE_WAIT_MS = 45_000;
// Linked machines refuse environment changes from callers below full access.
const PEER_LIMITS = { runtimeMode: "full-access", interactionMode: "default" } as const;

const isCopyable = Schema.is(MachinePlanCopyableCategory);

export class MachinePlanInvalidError extends Schema.TaggedError<MachinePlanInvalidError>()(
  "MachinePlanInvalidError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason.slice(0, MAX_MESSAGE);
  }
}

export type MachinePlanRunOutcome =
  | { readonly _tag: "InputRequired"; readonly inputRequired: McpSchema.InputRequired }
  | { readonly _tag: "Finished"; readonly plan: MachinePlan; readonly cancelled: boolean };

type StoreError =
  | MachinePlanStore.MachinePlanNotFoundError
  | MachinePlanStore.MachinePlanReadError
  | MachinePlanStore.MachinePlanWriteError;

type RunError =
  | StoreError
  | MachinePlanInvalidError
  | MachinePlanApprover.MachinePlanApprovalUnavailableError;

export class MachinePlanRunner extends Context.Service<
  MachinePlanRunner,
  {
    /** Resolves and validates drafts; secret-bearing config becomes notes. */
    readonly propose: (input: {
      readonly threadId: ThreadId | null;
      readonly title: string;
      readonly notes: ReadonlyArray<string>;
      readonly steps: ReadonlyArray<MachinePlanStepDraft>;
    }) => Effect.Effect<
      MachinePlan,
      MachinePlanInvalidError | MachinePlanStore.MachinePlanWriteError
    >;
    readonly status: (
      planId: string,
    ) => Effect.Effect<
      MachinePlan,
      MachinePlanStore.MachinePlanNotFoundError | MachinePlanStore.MachinePlanReadError
    >;
    /** Asks the user about every proposed step at once, then runs approved steps in order. */
    readonly execute: (input: {
      readonly planId: string;
      readonly stepIds?: ReadonlyArray<string> | undefined;
      readonly callerThreadId?: ThreadId | undefined;
    }) => Effect.Effect<MachinePlanRunOutcome, RunError, McpSchema.McpRequestContext>;
    /** Undoes one done step, or every undoable done step in reverse, after the user approves. */
    readonly undo: (input: {
      readonly planId: string;
      readonly stepId?: string | undefined;
      readonly callerThreadId?: ThreadId | undefined;
    }) => Effect.Effect<MachinePlanRunOutcome, RunError, McpSchema.McpRequestContext>;
  }
>()("t3/machines/assistant/MachinePlanRunner") {}

const bounded = (text: string) => text.slice(0, MAX_MESSAGE);

/** Errors here carry server-written messages; anything untagged is not shown. */
const failureMessage = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error && "message" in error
    ? bounded(String(error.message))
    : "The step could not be completed.";

class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", {
  reason: Schema.String,
}) {}

const stepFailed = (error: unknown) => new StepFailed({ reason: failureMessage(error) });

const reportMessage = (report: MachineTransferReport) => {
  const imported = report.sessions.filter(
    (session) => session.status === "imported" || session.status === "updated",
  ).length;
  const sessions =
    report.sessions.length === 0
      ? ""
      : ` ${imported} of ${report.sessions.length} sessions imported.`;
  const tree =
    report.workingTree === null
      ? ""
      : report.undo.available
        ? " Uncommitted work applied."
        : " Uncommitted work not applied; see the transfer report.";
  return bounded(`Transfer ${report.transferId} completed.${sessions}${tree}`);
};

const noteFor = (item: MachineConfigItem, machine: string) => {
  switch (item.category) {
    case "mcp-server":
      return `MCP server "${item.name}" (${item.transport}${item.command === null ? "" : `, \`${item.command}\``}) on ${machine}: add it here yourself and fill in its env, args and headers.`;
    case "hook":
      return `Hook for ${item.event} on ${machine}: recreate it here yourself.`;
    case "permission":
      return `Permission ${item.behavior} "${item.rule}" on ${machine}: add it here yourself if you want it.`;
    case "env":
      return `Environment variable ${item.name} on ${machine}: set its value here yourself.`;
    case "plugin":
      return `Plugin "${item.name}" on ${machine}: install it here yourself.`;
    case "marketplace":
      return `Plugin marketplace "${item.name}" on ${machine}: add it here yourself.`;
    default:
      return `${item.category} "${item.name}" on ${machine}: copy it yourself.`;
  }
};

const make = Effect.gen(function* () {
  const store = yield* MachinePlanStore.MachinePlanStore;
  const approver = yield* MachinePlanApprover.MachinePlanApprover;
  const configApply = yield* MachineConfigApply.MachineConfigApply;
  const machinePeer = yield* MachinePeerClient.MachinePeerClient;
  const receiver = yield* MachineReceiver.MachineReceiver;
  const peerMcp = yield* PeerMcpClient.PeerMcpClient;
  const links = yield* PeerLinks.PeerLinks;
  const repositories = yield* SourceControlRepositoryService.SourceControlRepositoryService;
  const projects = yield* ProjectService.ProjectService;
  const environmentIdentity = yield* ServerEnvironmentIdentity;
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const locks = yield* KeyedLock.make<string>();

  const invalid = (reason: string) => new MachinePlanInvalidError({ reason });
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const isLocal = Effect.fnUntraced(function* (environmentId: EnvironmentId | null) {
    return (
      environmentId === null || environmentId === (yield* environmentIdentity.getEnvironmentId)
    );
  });

  const machineName = Effect.fnUntraced(function* (environmentId: EnvironmentId | null) {
    if (yield* isLocal(environmentId)) return "this machine";
    const link = yield* links.get(environmentId!).pipe(Effect.orElseSucceed(() => Option.none()));
    return Option.isSome(link) ? `"${link.value.label}"` : `machine ${environmentId}`;
  });

  const destinationExists = (destinationPath: string) =>
    fileSystem.exists(destinationPath).pipe(Effect.orElseSucceed(() => true));

  const sourceRemote = Effect.fnUntraced(function* (
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) {
    const identity = yield* machinePeer.identity(environmentId, { projectId });
    const remotes = identity.remotes.filter((remote) => remote.canonicalKey !== null);
    const remote = remotes.find((candidate) => candidate.name === "origin") ?? remotes[0];
    return { identity, remoteUrl: remote?.url };
  });

  type Resolved =
    | { readonly _tag: "Step"; readonly step: MachinePlanStep }
    | { readonly _tag: "Note"; readonly note: string };

  const resolveStep = Effect.fn("MachinePlanRunner.resolveStep")(function* (
    draft: MachinePlanStepDraft,
  ): Effect.fn.Return<Resolved, MachinePlanInvalidError> {
    const base = {
      id: draft.id,
      dependsOn: draft.dependsOn,
      status: "proposed" as const,
      result: null,
    };
    const fail = (error: unknown) => invalid(`Step ${draft.id}: ${failureMessage(error)}`);
    switch (draft.type) {
      case "receive": {
        const { destinationEnvironmentId, receive } = draft.input;
        if (yield* isLocal(receive.sourceEnvironmentId)) {
          return yield* invalid(`Step ${draft.id}: the source must be another machine.`);
        }
        const local = yield* isLocal(destinationEnvironmentId);
        const source = yield* machineName(receive.sourceEnvironmentId);
        const destination = yield* machineName(destinationEnvironmentId);
        const where = local
          ? (yield* machinePeer
              .identity(receive.sourceEnvironmentId, {
                projectId: receive.sourceProjectId,
                ...(receive.sourceWorktreePath === undefined
                  ? {}
                  : { worktreePath: receive.sourceWorktreePath }),
              })
              .pipe(Effect.mapError(fail))).checkoutRoot
          : `project ${receive.sourceProjectId}`;
        const mode = receive.workingTree ?? "auto";
        const parts = [
          ...(receive.sessionIds === undefined || receive.sessionIds.length === 0
            ? []
            : [
                `${receive.sessionIds.length} Claude session${receive.sessionIds.length === 1 ? "" : "s"}`,
              ]),
          ...(mode === "auto"
            ? ["uncommitted work (applied only if the checkout matches)"]
            : mode === "refs-only"
              ? ["uncommitted work as git refs only"]
              : []),
        ];
        if (parts.length === 0) {
          return yield* invalid(
            `Step ${draft.id}: it receives neither sessions nor uncommitted work.`,
          );
        }
        const into =
          receive.destinationProjectId === undefined
            ? `the matching project on ${destination}`
            : `project ${receive.destinationProjectId} on ${destination}`;
        return {
          _tag: "Step",
          step: {
            ...base,
            type: "receive",
            input: { destinationEnvironmentId: local ? null : destinationEnvironmentId, receive },
            summary: `Receive ${parts.join(" and ")} from ${where} on ${source} into ${into}.`,
            undoable: mode === "auto",
          },
        };
      }
      case "clone-project": {
        const input = draft.input;
        if (yield* isLocal(input.sourceEnvironmentId)) {
          return yield* invalid(`Step ${draft.id}: the source must be another machine.`);
        }
        if (!path.isAbsolute(input.destinationPath)) {
          return yield* invalid(`Step ${draft.id}: destinationPath must be an absolute path.`);
        }
        if (yield* destinationExists(input.destinationPath)) {
          return yield* invalid(
            `Step ${draft.id}: ${bounded(input.destinationPath)} already exists.`,
          );
        }
        const { identity, remoteUrl } = yield* sourceRemote(
          input.sourceEnvironmentId,
          input.sourceProjectId,
        ).pipe(Effect.mapError(fail));
        if (remoteUrl === undefined) {
          return yield* invalid(`Step ${draft.id}: that checkout has no remote to clone from.`);
        }
        const source = yield* machineName(input.sourceEnvironmentId);
        return {
          _tag: "Step",
          step: {
            ...base,
            type: "clone-project",
            input,
            preconditions: { remoteUrl },
            summary: `Clone ${remoteUrl} (the remote of ${identity.checkoutRoot} on ${source}) into ${input.destinationPath} and add it as a project.`,
            undoable: false,
          },
        };
      }
      case "copy-config": {
        const input = draft.input;
        if (yield* isLocal(input.sourceEnvironmentId)) {
          return yield* invalid(`Step ${draft.id}: the source must be another machine.`);
        }
        const source = yield* machineName(input.sourceEnvironmentId);
        const read = yield* machinePeer
          .readConfigItem(input.sourceEnvironmentId, input.itemId)
          .pipe(Effect.mapError(fail));
        const category = read.item.category;
        if (!isCopyable(category)) return { _tag: "Note", note: noteFor(read.item, source) };
        if (read.content === null) {
          return yield* invalid(`Step ${draft.id}: ${source} did not send that item's content.`);
        }
        const destinationPath = yield* configApply
          .destinationOf(read.item)
          .pipe(Effect.mapError(fail));
        const destinationSha256 = yield* configApply
          .sha256Of(destinationPath)
          .pipe(Effect.mapError(fail));
        if (destinationSha256 === read.content.sha256) {
          return {
            _tag: "Note",
            note: `${category} "${read.item.name}" is already the same here.`,
          };
        }
        return {
          _tag: "Step",
          step: {
            ...base,
            type: "copy-config",
            input,
            preconditions: {
              category,
              sourceSha256: read.content.sha256,
              destinationPath,
              destinationSha256,
            },
            summary: `Copy ${category} "${read.item.name}" from ${source} to ${destinationPath}${destinationSha256 === null ? " (new file)" : " (replaces the file there; a backup is kept)"}.`,
            undoable: true,
          },
        };
      }
    }
  });

  const propose: MachinePlanRunner["Service"]["propose"] = Effect.fn("MachinePlanRunner.propose")(
    function* (input) {
      if (input.steps.length === 0) return yield* invalid("A plan needs at least one step.");
      if (input.steps.length > MAX_STEPS) {
        return yield* invalid(`A plan has at most ${MAX_STEPS} steps.`);
      }
      const seen = new Set<string>();
      for (const draft of input.steps) {
        if (seen.has(draft.id)) return yield* invalid(`Step id ${draft.id} is used twice.`);
        const unknown = draft.dependsOn.find((id) => !seen.has(id));
        if (unknown !== undefined) {
          return yield* invalid(
            `Step ${draft.id} depends on ${unknown}, which is not an earlier step.`,
          );
        }
        seen.add(draft.id);
      }
      const notes = [...input.notes];
      const steps: Array<MachinePlanStep> = [];
      const dropped = new Set<string>();
      for (const draft of input.steps) {
        const resolved = yield* resolveStep(draft);
        if (resolved._tag === "Note") {
          notes.push(resolved.note);
          dropped.add(draft.id);
          continue;
        }
        steps.push({
          ...resolved.step,
          dependsOn: resolved.step.dependsOn.filter((id) => !dropped.has(id)),
        });
      }
      return yield* store.create({ threadId: input.threadId, title: input.title, notes, steps });
    },
  );

  const setStep = (
    planId: string,
    stepId: string,
    patch: Partial<Pick<MachinePlanStep, "status" | "result" | "input">>,
  ) =>
    store.update(planId, (plan) => ({
      ...plan,
      steps: plan.steps.map((step) =>
        step.id === stepId ? ({ ...step, ...patch } as MachinePlanStep) : step,
      ),
    }));

  const result = Effect.fnUntraced(function* (
    message: string,
    extra: Partial<Omit<MachinePlanStepResult, "finishedAt" | "message">> = {},
  ) {
    return { finishedAt: yield* nowIso, message: bounded(message), ...extra };
  });

  const remoteReport = (
    environmentId: EnvironmentId,
    tool: string,
    args: Record<string, unknown>,
  ) =>
    peerMcp.call({
      environmentId,
      tool,
      arguments: args,
      limits: PEER_LIMITS,
      success: MachineTransferReport,
    });

  const runReceive = Effect.fn("MachinePlanRunner.runReceive")(function* (
    step: Extract<MachinePlanStep, { type: "receive" }>,
    transferId: string,
    callerThreadId: ThreadId | undefined,
  ) {
    const { destinationEnvironmentId, receive } = step.input;
    let report: MachineTransferReport;
    if (destinationEnvironmentId === null) {
      report = yield* receiver
        .receive({
          ...receive,
          transferId,
          waitMs: RECEIVE_WAIT_MS,
          ...(callerThreadId === undefined ? {} : { callerThreadId }),
        })
        .pipe(Effect.mapError(stepFailed));
      while (report.status === "running") {
        report = yield* receiver
          .report({ transferId, waitMs: RECEIVE_WAIT_MS })
          .pipe(Effect.mapError(stepFailed));
      }
    } else {
      report = yield* remoteReport(destinationEnvironmentId, "t3_machines_receive", {
        ...receive,
        transferId,
      }).pipe(Effect.mapError(stepFailed));
      while (report.status === "running") {
        report = yield* remoteReport(destinationEnvironmentId, "t3_machines_receive", {
          transferId,
        }).pipe(Effect.mapError(stepFailed));
      }
    }
    if (report.status === "failed") {
      return yield* new StepFailed({
        reason: bounded(`Transfer ${transferId} failed: ${report.error ?? "unknown error"}`),
      });
    }
    return yield* result(reportMessage(report), {
      transferId,
      projectId: report.destination.projectId,
    });
  });

  const runClone = Effect.fn("MachinePlanRunner.runClone")(function* (
    step: Extract<MachinePlanStep, { type: "clone-project" }>,
  ) {
    const { sourceEnvironmentId, sourceProjectId, destinationPath } = step.input;
    const { identity } = yield* sourceRemote(sourceEnvironmentId, sourceProjectId).pipe(
      Effect.mapError(stepFailed),
    );
    if (!identity.remotes.some((remote) => remote.url === step.preconditions.remoteUrl)) {
      return yield* new StepFailed({
        reason: "The source checkout's remote changed since the plan was proposed.",
      });
    }
    if (yield* destinationExists(destinationPath)) {
      return yield* new StepFailed({
        reason: bounded(`${destinationPath} exists now; it did not when the plan was proposed.`),
      });
    }
    const cloned = yield* repositories
      .cloneRepository(
        { remoteUrl: step.preconditions.remoteUrl, destinationPath },
        { timeoutMs: null },
      )
      .pipe(Effect.mapError((error) => new StepFailed({ reason: bounded(error.detail) })));
    const id = yield* random.uuidV4();
    const project = yield* projects
      .create({
        commandId: CommandId.make(`machines-plan-clone:${id}`),
        projectId: ProjectId.make(id),
        title: path.basename(cloned.cwd),
        workspaceRoot: cloned.cwd,
      })
      .pipe(Effect.mapError(stepFailed));
    return yield* result(`Cloned into ${cloned.cwd} and added project ${project.title}.`, {
      projectId: project.id,
    });
  });

  const runCopyConfig = Effect.fn("MachinePlanRunner.runCopyConfig")(function* (
    planId: string,
    step: Extract<MachinePlanStep, { type: "copy-config" }>,
  ) {
    const { preconditions } = step;
    const read = yield* machinePeer
      .readConfigItem(step.input.sourceEnvironmentId, step.input.itemId)
      .pipe(Effect.mapError(stepFailed));
    if (read.content === null || read.content.sha256 !== preconditions.sourceSha256) {
      return yield* new StepFailed({
        reason: "The source file changed since the plan was proposed.",
      });
    }
    const written = yield* configApply
      .write({
        path: preconditions.destinationPath,
        content: read.content.content,
        expectedSha256: preconditions.destinationSha256,
        backupPath: store.backupPath(planId, step.id),
      })
      .pipe(Effect.mapError(stepFailed));
    return yield* result(`Wrote ${preconditions.destinationPath}.`, {
      replacedExisting: written.replacedExisting,
    });
  });

  const runStep = Effect.fn("MachinePlanRunner.runStep")(function* (
    plan: MachinePlan,
    step: MachinePlanStep,
    callerThreadId: ThreadId | undefined,
  ) {
    switch (step.type) {
      case "receive": {
        // Persisted before the transfer starts, so an interrupted run can find it again.
        const transferId = step.input.receive.transferId ?? `t-${yield* random.uuidV4()}`;
        yield* setStep(plan.id, step.id, {
          status: "running",
          input: { ...step.input, receive: { ...step.input.receive, transferId } },
        });
        return yield* runReceive(step, transferId, callerThreadId);
      }
      case "clone-project":
        yield* setStep(plan.id, step.id, { status: "running" });
        return yield* runClone(step);
      case "copy-config":
        yield* setStep(plan.id, step.id, { status: "running" });
        return yield* runCopyConfig(plan.id, step);
    }
  });

  const promptMessage = (plan: MachinePlan, step: MachinePlanStep, verb: "run" | "undo") => {
    const index = plan.steps.indexOf(step) + 1;
    const head =
      verb === "run"
        ? `Plan ${plan.id}, step ${index} of ${plan.steps.length}: ${step.summary}`
        : `Plan ${plan.id}, undo step ${index} of ${plan.steps.length}: ${step.summary}`;
    const tail =
      verb === "run" ? (step.undoable ? " Undo: available for 30 days." : " Undo: none.") : "";
    return `${head}${tail}`;
  };

  const DEPENDENCY_BLOCKING: ReadonlySet<MachinePlanStepStatus> = new Set([
    "declined",
    "failed",
    "skipped",
    "not-run",
    "undone",
  ]);

  const execute: MachinePlanRunner["Service"]["execute"] = Effect.fn("MachinePlanRunner.execute")(
    function* (input) {
      return yield* locks.withLock(
        input.planId,
        Effect.gen(function* () {
          let plan = yield* store.get(input.planId);
          const selected = new Set(input.stepIds ?? plan.steps.map((step) => step.id));
          const unknown = [...selected].find((id) => !plan.steps.some((step) => step.id === id));
          if (unknown !== undefined) return yield* invalid(`Plan has no step ${unknown}.`);

          // A run cut off mid-step: a receive resumes by its transfer id; anything else is unknown.
          for (const step of plan.steps) {
            if (step.status !== "running" || step.type === "receive") continue;
            plan = yield* setStep(plan.id, step.id, {
              status: "failed",
              result: yield* result(
                "The run stopped during this step; check the result and propose again.",
              ),
            });
          }

          const toAsk = plan.steps.filter(
            (step) => selected.has(step.id) && step.status === "proposed",
          );
          if (toAsk.length > 0) {
            const outcome = yield* approver.decide(
              toAsk.map((step) => ({
                planId: plan.id,
                stepId: step.id,
                message: promptMessage(plan, step, "run"),
              })),
            );
            if (outcome._tag === "InputRequired") return outcome;
            if ([...outcome.decisions.values()].includes("cancel")) {
              return { _tag: "Finished", plan, cancelled: true } as const;
            }
            plan = yield* store.update(plan.id, (current) => ({
              ...current,
              steps: current.steps.map((step) => {
                const decision = outcome.decisions.get(step.id);
                if (decision === undefined || step.status !== "proposed") return step;
                return { ...step, status: decision === "approve" ? "approved" : "declined" };
              }),
            }));
          }

          for (const candidate of plan.steps) {
            const step = plan.steps.find((current) => current.id === candidate.id)!;
            if (!selected.has(step.id)) continue;
            if (
              step.status !== "approved" &&
              !(step.status === "running" && step.type === "receive")
            ) {
              continue;
            }
            const blocker = step.dependsOn
              .map((id) => plan.steps.find((other) => other.id === id))
              .find((other) => other !== undefined && other.status !== "done");
            if (blocker !== undefined) {
              plan = yield* setStep(plan.id, step.id, {
                status: DEPENDENCY_BLOCKING.has(blocker.status) ? "skipped" : "not-run",
                result: yield* result(`Skipped: step ${blocker.id} did not complete.`),
              });
              continue;
            }
            const outcome = yield* runStep(plan, step, input.callerThreadId).pipe(Effect.result);
            if (outcome._tag === "Success") {
              plan = yield* setStep(plan.id, step.id, { status: "done", result: outcome.success });
              continue;
            }
            const error = outcome.failure;
            if (error._tag !== "StepFailed") return yield* error;
            plan = yield* setStep(plan.id, step.id, {
              status: "failed",
              result: yield* result(error.reason),
            });
            const notRun = yield* result("Not run: an earlier step failed.");
            plan = yield* store.update(plan.id, (current) => ({
              ...current,
              steps: current.steps.map((other) =>
                selected.has(other.id) && other.status === "approved"
                  ? { ...other, status: "not-run", result: notRun }
                  : other,
              ),
            }));
            break;
          }
          return { _tag: "Finished", plan, cancelled: false } as const;
        }),
      );
    },
  );

  const undoStep = Effect.fn("MachinePlanRunner.undoStep")(function* (
    plan: MachinePlan,
    step: MachinePlanStep,
    callerThreadId: ThreadId | undefined,
  ) {
    switch (step.type) {
      case "receive": {
        const transferId = step.result?.transferId;
        if (transferId === undefined) {
          return yield* new StepFailed({ reason: "This step has no transfer to undo." });
        }
        if (step.input.destinationEnvironmentId === null) {
          yield* receiver
            .undo({ transferId, ...(callerThreadId === undefined ? {} : { callerThreadId }) })
            .pipe(Effect.mapError(stepFailed));
        } else {
          yield* remoteReport(step.input.destinationEnvironmentId, "t3_machines_undo", {
            transferId,
          }).pipe(Effect.mapError(stepFailed));
        }
        return yield* result(`Restored the working tree from before transfer ${transferId}.`, {
          transferId,
        });
      }
      case "copy-config": {
        const replacedExisting = step.result?.replacedExisting;
        if (replacedExisting === undefined) {
          return yield* new StepFailed({ reason: "This step has nothing recorded to undo." });
        }
        yield* configApply
          .restore({
            path: step.preconditions.destinationPath,
            backupPath: store.backupPath(plan.id, step.id),
            replacedExisting,
            writtenSha256: step.preconditions.sourceSha256,
          })
          .pipe(Effect.mapError(stepFailed));
        return yield* result(
          replacedExisting
            ? `Restored the previous ${step.preconditions.destinationPath}.`
            : `Removed ${step.preconditions.destinationPath}.`,
          { replacedExisting },
        );
      }
      case "clone-project":
        return yield* new StepFailed({ reason: "A clone cannot be undone here." });
    }
  });

  const undo: MachinePlanRunner["Service"]["undo"] = Effect.fn("MachinePlanRunner.undo")(
    function* (input) {
      return yield* locks.withLock(
        input.planId,
        Effect.gen(function* () {
          let plan = yield* store.get(input.planId);
          const targets = plan.steps
            .filter(
              (step) =>
                step.status === "done" &&
                step.undoable &&
                (input.stepId === undefined || step.id === input.stepId),
            )
            .toReversed();
          if (targets.length === 0) {
            return yield* invalid(
              input.stepId === undefined
                ? "No completed step of this plan can be undone."
                : `Step ${input.stepId} is not a completed step that can be undone.`,
            );
          }
          const promptId = (step: MachinePlanStep) => `undo:${step.id}`;
          const outcome = yield* approver.decide(
            targets.map((step) => ({
              planId: plan.id,
              stepId: promptId(step),
              message: promptMessage(plan, step, "undo"),
            })),
          );
          if (outcome._tag === "InputRequired") return outcome;
          if ([...outcome.decisions.values()].includes("cancel")) {
            return { _tag: "Finished", plan, cancelled: true } as const;
          }
          for (const step of targets) {
            if (outcome.decisions.get(promptId(step)) !== "approve") continue;
            const undone = yield* undoStep(plan, step, input.callerThreadId).pipe(Effect.result);
            if (undone._tag === "Failure") {
              plan = yield* setStep(plan.id, step.id, {
                result: {
                  ...(step.result ?? (yield* result(""))),
                  message: bounded(`Undo failed: ${undone.failure.reason}`),
                },
              });
              break;
            }
            plan = yield* setStep(plan.id, step.id, { status: "undone", result: undone.success });
          }
          return { _tag: "Finished", plan, cancelled: false } as const;
        }),
      );
    },
  );

  return MachinePlanRunner.of({ propose, status: store.get, execute, undo });
});

export const layer = Layer.effect(MachinePlanRunner, make);
