import {
  type EnvironmentId,
  isMachineRequestRefusedError,
  type MachineCheckoutDescription,
  type MachineSessionSummary,
  type MachineSurvey,
  type MachineSurveyProject,
  type MachineTransferReport,
  type MachineWorkingTreeReport,
} from "@t3tools/contracts";
import { compareCheckouts, sameRepository } from "@t3tools/shared/machinesCheckout";
import type * as DateTime from "effect/DateTime";

import { type PeerLinkListState, type PeerLinkSupport, peerLinkView } from "./machines.logic";

export interface RepoCell {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly project: MachineSurveyProject;
  /** Claude sessions in this checkout that no thread owns yet. */
  readonly pendingSessions: ReadonlyArray<MachineSessionSummary>;
}

export interface RepoRow {
  readonly key: string;
  readonly title: string;
  readonly cells: ReadonlyArray<RepoCell>;
}

/**
 * One row per repository, matched across machines by shared remotes or root commits. Projects
 * that are not git checkouts cannot take part in a transfer and are left out. Rows on more than
 * one machine come first.
 */
export function groupRepositories(
  surveys: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly survey: Pick<MachineSurvey, "projects">;
  }>,
): ReadonlyArray<RepoRow> {
  const rows: Array<{ key: string; title: string; cells: Array<RepoCell> }> = [];
  for (const { environmentId, label, survey } of surveys) {
    for (const project of survey.projects) {
      const checkout = project.checkout;
      if (checkout === null) continue;
      const cell: RepoCell = {
        key: `${environmentId}\n${project.projectId}`,
        environmentId,
        machineLabel: label,
        project,
        pendingSessions: project.sessions.filter((session) => session.existingThreadId === null),
      };
      const row = rows.find((candidate) =>
        candidate.cells.some(
          (other) =>
            other.project.checkout !== null && sameRepository(other.project.checkout, checkout),
        ),
      );
      if (row === undefined) rows.push({ key: cell.key, title: project.title, cells: [cell] });
      else row.cells.push(cell);
    }
  }
  const machineCount = (row: RepoRow) => new Set(row.cells.map((cell) => cell.environmentId)).size;
  return rows.toSorted(
    (left, right) =>
      Number(machineCount(right) > 1) - Number(machineCount(left) > 1) ||
      left.title.localeCompare(right.title),
  );
}

export interface CheckoutFacts {
  readonly branch: string;
  readonly shortHead: string | null;
  readonly upstream: string | null;
  readonly dirty: Readonly<Record<MachineCheckoutDescription["entries"][number]["kind"], number>>;
  readonly dirtyTotal: number;
  readonly dirtyText: string;
  readonly stashes: number;
}

const DIRTY_LABELS = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  untracked: "untracked",
} as const;

export function checkoutFacts(description: MachineCheckoutDescription): CheckoutFacts {
  const dirty = { modified: 0, added: 0, deleted: 0, untracked: 0 };
  for (const entry of description.entries) dirty[entry.kind]++;
  const upstream = description.upstream;
  const upstreamText =
    upstream === null
      ? null
      : upstream.ahead === null || upstream.behind === null
        ? `${upstream.ref} (gone)`
        : upstream.ahead === 0 && upstream.behind === 0
          ? `up to date with ${upstream.ref}`
          : [
              upstream.ahead > 0 ? `${upstream.ahead} ahead` : null,
              upstream.behind > 0 ? `${upstream.behind} behind` : null,
            ]
              .filter((part) => part !== null)
              .join(", ") + ` ${upstream.ref}`;
  const parts = (Object.keys(DIRTY_LABELS) as Array<keyof typeof DIRTY_LABELS>).flatMap((kind) =>
    dirty[kind] > 0 ? [`${dirty[kind]} ${DIRTY_LABELS[kind]}`] : [],
  );
  return {
    branch: description.branch ?? "detached",
    shortHead: description.head?.slice(0, 7) ?? null,
    upstream: upstreamText,
    dirty,
    dirtyTotal: description.entries.length,
    dirtyText: parts.length === 0 ? "No uncommitted changes" : parts.join(", "),
    stashes: description.stashes.length,
  };
}

const PREVIEW_PATHS = 50;

/** What copying uncommitted work between two checkouts would touch, before any transfer. */
export function comparePreview(
  a: MachineCheckoutDescription,
  b: MachineCheckoutDescription,
  labels: { readonly a: string; readonly b: string },
) {
  const comparison = compareCheckouts(a, b);
  const statusLabels = {
    identical: "Same",
    differs: "Differs",
    "only-a": `Only on ${labels.a}`,
    "only-b": `Only on ${labels.b}`,
    unknown: "Changed on one side",
  } as const;
  const head =
    a.head === null || b.head === null
      ? "One side has no commit yet."
      : a.head === b.head
        ? "Same commit."
        : "Different commits. Files are compared after the transfer.";
  const changed = comparison.paths.filter((entry) => entry.status !== "identical");
  return {
    head,
    counts: comparison.summary.paths,
    paths: changed.slice(0, PREVIEW_PATHS).map((entry) => ({
      path: entry.path,
      status: statusLabels[entry.status],
    })),
    hiddenPaths: Math.max(0, changed.length - PREVIEW_PATHS),
  };
}

export interface TransferEnd {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly peerLinks: PeerLinkSupport;
  readonly links: PeerLinkListState;
  /** `orchestration:operate` and `source-control:write` on this machine. */
  readonly canReceive: boolean;
}

/** Why the destination cannot pull from the source, or null when it may try. */
export function receiveBlockReason(
  source: TransferEnd,
  destination: TransferEnd,
  now: DateTime.Utc,
): string | null {
  if (source.environmentId === destination.environmentId) return "Pick two different machines.";
  if (!destination.connected) return `${destination.label} is not connected.`;
  if (!destination.canReceive) return `No permission to receive on ${destination.label}.`;
  if (destination.peerLinks !== "on") return `Linked environments is off on ${destination.label}.`;
  // Unread links are left to the server, which refuses with a reason.
  if (destination.links.kind === "ready") {
    const link = destination.links.links.find(
      (candidate) => candidate.environmentId === source.environmentId,
    );
    if (link === undefined) return `${destination.label} is not linked to ${source.label}.`;
    if (!peerLinkView(link, now).live) {
      return `${destination.label}'s link to ${source.label} does not work. Link them again.`;
    }
  }
  return null;
}

export function copyWorkBlockReason(
  source: TransferEnd,
  destination: TransferEnd,
  sourceFacts: CheckoutFacts | null,
  now: DateTime.Utc,
): string | null {
  const reason = receiveBlockReason(source, destination, now);
  if (reason !== null) return reason;
  if (sourceFacts === null) return `Loading ${source.label}'s checkout…`;
  if (sourceFacts.dirtyTotal === 0) return `Nothing uncommitted on ${source.label}.`;
  return null;
}

const WORKING_TREE_REASONS: Record<MachineWorkingTreeReport["reason"], string> = {
  "not-requested": "Uncommitted work was not requested.",
  requested: "Uncommitted work was requested.",
  "nothing-to-apply": "There was no uncommitted work to copy.",
  "different-head": "The machines are on different commits, so the work was not applied.",
  "destination-changes": "The destination has its own changes in these files:",
  "checkout-busy": "An agent is working there, so the work was not applied.",
  "already-applied": "This work was already copied.",
  safe: "Uncommitted work copied.",
};

const HEAD_RELATIONS: Record<MachineWorkingTreeReport["headRelation"], string | null> = {
  same: null,
  "source-ahead": "The source is ahead.",
  "destination-ahead": "The destination is ahead.",
  diverged: "The two branches have diverged.",
  unknown: null,
};

const SESSION_STATUSES: Record<MachineTransferReport["sessions"][number]["status"], string> = {
  imported: "Imported",
  "existing-thread": "Already a thread",
  updated: "Updated",
  conflict: "Owned by another thread",
  skipped: "Skipped",
  busy: "Busy on the source",
};

export type TransferReportTone = "running" | "failed" | "done";

/** Everything a transfer report says, as text. */
export function transferReportView(report: MachineTransferReport) {
  const tone: TransferReportTone =
    report.status === "running" ? "running" : report.status === "failed" ? "failed" : "done";
  const tree = report.workingTree;
  const workingTree =
    tree === null || tree.reason === "not-requested"
      ? null
      : {
          action: tree.action,
          headline: WORKING_TREE_REASONS[tree.reason],
          headRelation: tree.reason === "different-head" ? HEAD_RELATIONS[tree.headRelation] : null,
          blocking: tree.reason === "destination-changes" ? tree.blocking : [],
          summary: tree.summary,
          // Refs are kept so the work can still be reached by hand when it was not applied.
          refs:
            tree.action === "refs-only" && tree.importedRefs !== null
              ? [tree.importedRefs.snapshot, tree.importedRefs.branch].filter((ref) => ref !== null)
              : [],
          safetyRef: tree.safetyRef,
        };
  return {
    tone,
    headline:
      report.status === "running"
        ? report.phase
        : report.status === "failed"
          ? (report.error ?? "The transfer failed.")
          : report.undo.undoneAt !== null
            ? "Undone."
            : "Done.",
    workingTree,
    sessions: report.sessions.map((session) => ({
      sessionId: session.sessionId,
      threadId: session.threadId,
      status: SESSION_STATUSES[session.status],
      reason: session.reason ?? null,
    })),
    canUndo:
      report.status === "completed" && report.undo.available && report.undo.undoneAt === null,
  };
}

export function transferFailureMessage(failure: unknown): string {
  if (isMachineRequestRefusedError(failure)) return failure.message;
  if (failure instanceof Error && failure.message.trim().length > 0) return failure.message;
  return "The request failed. Try again.";
}
