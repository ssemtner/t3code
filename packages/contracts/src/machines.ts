import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const MACHINE_TRANSFER_ROUTE_PREFIX = "/api/machines";

const MachineSessionIds = Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(20));

export const MachineCheckoutRemote = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  // Null for local paths, which would give unrelated repositories the same key.
  canonicalKey: Schema.NullOr(Schema.String),
});
export type MachineCheckoutRemote = typeof MachineCheckoutRemote.Type;

export const MachineWorkingTreeEntry = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["modified", "added", "deleted", "untracked"]),
  mode: Schema.NullOr(Schema.String),
  blobId: Schema.NullOr(Schema.String),
});
export type MachineWorkingTreeEntry = typeof MachineWorkingTreeEntry.Type;

export const MachineCheckoutDescription = Schema.Struct({
  head: Schema.NullOr(Schema.String),
  /** Null when HEAD is detached. */
  branch: Schema.NullOr(Schema.String),
  upstream: Schema.NullOr(
    Schema.Struct({
      ref: Schema.String,
      // Null when the upstream branch no longer exists.
      ahead: Schema.NullOr(Schema.Number),
      behind: Schema.NullOr(Schema.Number),
    }),
  ),
  remotes: Schema.Array(MachineCheckoutRemote),
  rootCommits: Schema.Array(Schema.String),
  /** Paths are relative to the repository root. */
  entries: Schema.Array(MachineWorkingTreeEntry),
  stashes: Schema.Array(
    Schema.Struct({ commit: Schema.String, baseCommit: Schema.String, subject: Schema.String }),
  ),
});
export type MachineCheckoutDescription = typeof MachineCheckoutDescription.Type;

export const MachineCheckoutIdentity = Schema.Struct({
  projectId: ProjectId,
  projectRoot: TrimmedNonEmptyString,
  checkoutRoot: TrimmedNonEmptyString,
  head: MachineCheckoutDescription.fields.head,
  branch: MachineCheckoutDescription.fields.branch,
  remotes: MachineCheckoutDescription.fields.remotes,
  rootCommits: MachineCheckoutDescription.fields.rootCommits,
});
export type MachineCheckoutIdentity = typeof MachineCheckoutIdentity.Type;

export const MachineSessionSummary = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String),
  firstTimestamp: Schema.NullOr(IsoDateTime),
  lastTimestamp: Schema.NullOr(IsoDateTime),
  size: NonNegativeInt,
  lineCount: NonNegativeInt,
  projectDirName: Schema.String,
  firstCwd: Schema.NullOr(Schema.String),
  /** Filed under a project directory other than the one it mostly touched. */
  filedElsewhere: Schema.Boolean,
  roots: Schema.Array(
    Schema.Struct({ root: Schema.String, cwdLines: NonNegativeInt, toolPaths: NonNegativeInt }),
  ),
  existingThreadId: Schema.NullOr(ThreadId),
});
export type MachineSessionSummary = typeof MachineSessionSummary.Type;

export const MachineTransferStatus = Schema.Literals(["running", "completed", "failed"]);
export type MachineTransferStatus = typeof MachineTransferStatus.Type;

export const MachineSurveyProject = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  checkout: Schema.NullOr(MachineCheckoutIdentity),
  checkoutError: Schema.NullOr(Schema.String),
  /** At most 20, newest first. */
  sessions: Schema.Array(MachineSessionSummary),
  sessionsTruncated: Schema.Boolean,
  /** At most 5, newest first. */
  recentTransfers: Schema.Array(
    Schema.Struct({ id: TrimmedNonEmptyString, status: MachineTransferStatus, at: IsoDateTime }),
  ),
});
export type MachineSurveyProject = typeof MachineSurveyProject.Type;

export const MachineSurvey = Schema.Struct({
  environmentId: EnvironmentId,
  generatedAt: IsoDateTime,
  projects: Schema.Array(MachineSurveyProject),
});
export type MachineSurvey = typeof MachineSurvey.Type;

export const MachineTransferRequest = Schema.Struct({
  transferId: TrimmedNonEmptyString,
  sourceProjectId: ProjectId,
  sourceWorktreePath: Schema.optionalKey(TrimmedNonEmptyString),
  sessionIds: MachineSessionIds,
  workingTree: Schema.Boolean,
  /** Commits the destination already has. */
  haves: Schema.Array(Schema.String),
});
export type MachineTransferRequest = typeof MachineTransferRequest.Type;

export const MachineTransferFile = Schema.Struct({
  index: NonNegativeInt,
  kind: Schema.Literals(["bundle", "session"]),
  sessionId: Schema.optionalKey(TrimmedNonEmptyString),
  relativePath: Schema.optionalKey(Schema.String),
  sizeBytes: NonNegativeInt,
  sha256: Schema.String,
});
export type MachineTransferFile = typeof MachineTransferFile.Type;

export const MachineTransferManifest = Schema.Struct({
  transferId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  source: Schema.Struct({
    environmentId: EnvironmentId,
    homeDir: Schema.String,
    claudeConfigDir: Schema.String,
    projectId: ProjectId,
    projectRoot: Schema.String,
    checkoutRoot: Schema.NullOr(Schema.String),
    worktreeRoots: Schema.Array(Schema.String),
  }),
  checkout: Schema.NullOr(
    Schema.Struct({
      description: MachineCheckoutDescription,
      snapshotCommit: Schema.String,
      snapshotRef: Schema.String,
      branchRef: Schema.NullOr(Schema.String),
    }),
  ),
  files: Schema.Array(MachineTransferFile),
  sessions: Schema.Array(
    Schema.Struct({
      sessionId: TrimmedNonEmptyString,
      title: Schema.NullOr(Schema.String),
      status: Schema.Literals(["staged", "busy", "missing"]),
    }),
  ),
  warnings: Schema.Array(Schema.String),
});
export type MachineTransferManifest = typeof MachineTransferManifest.Type;

export const MachinePrepareResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("preparing") }),
  Schema.Struct({ status: Schema.Literal("ready"), manifest: MachineTransferManifest }),
]);
export type MachinePrepareResult = typeof MachinePrepareResult.Type;

export const MachineWorkingTreeMode = Schema.Literals(["auto", "refs-only", "none"]);
export type MachineWorkingTreeMode = typeof MachineWorkingTreeMode.Type;

export const MachineWorkingTreeReason = Schema.Literals([
  "not-requested",
  "requested",
  "nothing-to-apply",
  "different-head",
  "destination-changes",
  "checkout-busy",
  "already-applied",
  "safe",
]);
export type MachineWorkingTreeReason = typeof MachineWorkingTreeReason.Type;

export const MachineHeadRelation = Schema.Literals([
  "same",
  "source-ahead",
  "destination-ahead",
  "diverged",
  "unknown",
]);
export type MachineHeadRelation = typeof MachineHeadRelation.Type;

export const MachinePathStatus = Schema.Literals([
  "identical",
  "only-source",
  "only-destination",
  "differs",
  "unknown",
]);
export type MachinePathStatus = typeof MachinePathStatus.Type;

const MachineCheckoutPosition = Schema.Struct({
  head: MachineCheckoutDescription.fields.head,
  branch: MachineCheckoutDescription.fields.branch,
  upstream: MachineCheckoutDescription.fields.upstream,
});

export const MachineWorkingTreeReport = Schema.Struct({
  action: Schema.Literals(["applied", "refs-only", "skipped"]),
  reason: MachineWorkingTreeReason,
  source: MachineCheckoutPosition,
  destination: MachineCheckoutPosition,
  headRelation: MachineHeadRelation,
  mergeBase: Schema.NullOr(Schema.String),
  importedRefs: Schema.NullOr(
    Schema.Struct({ snapshot: Schema.String, branch: Schema.NullOr(Schema.String) }),
  ),
  safetyRef: Schema.NullOr(Schema.String),
  counts: Schema.Struct({
    identical: NonNegativeInt,
    onlySource: NonNegativeInt,
    onlyDestination: NonNegativeInt,
    differs: NonNegativeInt,
    unknown: NonNegativeInt,
  }),
  stashes: Schema.Struct({
    both: NonNegativeInt,
    onlySource: NonNegativeInt,
    onlyDestination: NonNegativeInt,
  }),
  /** Paths whose destination changes applying the source would lose. */
  blocking: Schema.Array(Schema.String),
  /** At most 200. */
  paths: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      status: MachinePathStatus,
      sourceKind: Schema.NullOr(MachineWorkingTreeEntry.fields.kind),
      destinationKind: Schema.NullOr(MachineWorkingTreeEntry.fields.kind),
    }),
  ),
  truncated: Schema.Boolean,
  summary: Schema.String,
});
export type MachineWorkingTreeReport = typeof MachineWorkingTreeReport.Type;

export const MachineTransferReport = Schema.Struct({
  transferId: TrimmedNonEmptyString,
  status: MachineTransferStatus,
  phase: TrimmedNonEmptyString,
  sourceEnvironmentId: EnvironmentId,
  destination: Schema.Struct({ projectId: ProjectId, root: Schema.String }),
  workingTree: Schema.NullOr(MachineWorkingTreeReport),
  sessions: Schema.Array(
    Schema.Struct({
      sessionId: TrimmedNonEmptyString,
      threadId: Schema.NullOr(ThreadId),
      status: Schema.Literals([
        "imported",
        "existing-thread",
        "updated",
        "conflict",
        "skipped",
        "busy",
      ]),
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
  undo: Schema.Struct({ available: Schema.Boolean, undoneAt: Schema.NullOr(IsoDateTime) }),
  error: Schema.NullOr(Schema.String),
});
export type MachineTransferReport = typeof MachineTransferReport.Type;

export const MachineReceiveInput = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceProjectId: ProjectId,
  sourceWorktreePath: Schema.optionalKey(TrimmedNonEmptyString),
  sessionIds: Schema.optionalKey(MachineSessionIds),
  workingTree: Schema.optionalKey(MachineWorkingTreeMode),
  destinationProjectId: Schema.optionalKey(ProjectId),
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
  transferId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type MachineReceiveInput = typeof MachineReceiveInput.Type;

/** Claude sessions already on this machine, opened as threads in one of its projects. */
export const MachineLocalImportInput = Schema.Struct({
  projectId: ProjectId,
  sessionIds: MachineSessionIds.check(Schema.isMinLength(1)),
});
export type MachineLocalImportInput = typeof MachineLocalImportInput.Type;

export const MachineLocalImportResult = Schema.Struct({
  projectId: ProjectId,
  sessions: Schema.Array(
    Schema.Struct({
      sessionId: TrimmedNonEmptyString,
      threadId: Schema.NullOr(ThreadId),
      status: Schema.Literals(["imported", "existing-thread", "not-found", "failed"]),
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type MachineLocalImportResult = typeof MachineLocalImportResult.Type;

export const MachineSurveyInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  sinceDays: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(90)),
  ),
});
export type MachineSurveyInput = typeof MachineSurveyInput.Type;

export const MachineCheckoutInput = Schema.Struct({
  projectId: ProjectId,
  worktreePath: Schema.optionalKey(TrimmedNonEmptyString),
});
export type MachineCheckoutInput = typeof MachineCheckoutInput.Type;

export const MachineCheckoutDetail = Schema.Struct({
  identity: MachineCheckoutIdentity,
  description: MachineCheckoutDescription,
});
export type MachineCheckoutDetail = typeof MachineCheckoutDetail.Type;

export const MachineInventoryInput = Schema.Struct({
  projectRoots: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(50)),
  ),
});
export type MachineInventoryInput = typeof MachineInventoryInput.Type;

export const MachineThreadMoveSource = Schema.Struct({
  threadId: ThreadId,
  /** The Claude session the thread resumes; null before its first turn. */
  sessionId: Schema.NullOr(TrimmedNonEmptyString),
  driver: Schema.NullOr(ProviderDriverKind),
  projectId: ProjectId,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  checkoutRoot: TrimmedNonEmptyString,
  idle: Schema.Boolean,
  refusal: Schema.NullOr(Schema.Literals(["not-claude", "no-session", "thread-busy"])),
});
export type MachineThreadMoveSource = typeof MachineThreadMoveSource.Type;

export const MachineMarkMovedInput = Schema.Struct({
  destinationEnvironmentId: EnvironmentId,
  destinationThreadId: ThreadId,
  transferId: TrimmedNonEmptyString,
});
export type MachineMarkMovedInput = typeof MachineMarkMovedInput.Type;

export const MachineThreadMove = Schema.Struct({
  threadId: ThreadId,
  destinationEnvironmentId: EnvironmentId,
  destinationThreadId: ThreadId,
  transferId: TrimmedNonEmptyString,
  movedAt: IsoDateTime,
});
export type MachineThreadMove = typeof MachineThreadMove.Type;

export const MachineThreadMoveList = Schema.Struct({ moves: Schema.Array(MachineThreadMove) });
export type MachineThreadMoveList = typeof MachineThreadMoveList.Type;

export const MachineRefusalCode = Schema.Literals([
  "source-unavailable",
  "links-disabled",
  "no-matching-project",
  "ambiguous-project",
  "unrelated-project",
  "claude-unavailable",
  "project-not-found",
  "worktree-not-found",
  "not-repository",
  "transfer-not-found",
  "undo-unavailable",
  "checkout-busy",
]);
export type MachineRefusalCode = typeof MachineRefusalCode.Type;

/** A machines request the server understood but will not carry out; `message` is for people. */
export class MachineRequestRefusedError extends Schema.TaggedError<MachineRequestRefusedError>()(
  "MachineRequestRefusedError",
  {
    code: MachineRefusalCode,
    message: Schema.String,
    candidates: Schema.optionalKey(Schema.Array(ProjectId)),
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(MachineRequestRefusedError)(this, { status: 409 });
  }
}
export const isMachineRequestRefusedError = Schema.is(MachineRequestRefusedError);
