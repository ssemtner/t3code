import {
  type EnvironmentId,
  type MachineReceiveInput,
  type MachineThreadMove,
  type MachineThreadMoveSource,
  type MachineTransferReport,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

import { type PeerLinkListState, type PeerLinkSupport, peerLinkView } from "./machines.logic";

/** What a moved thread leaves behind, shown before the user confirms. */
export const NOT_CARRIED = [
  "The moved thread shows its history as text only: no tool cards, diffs, checkpoints or images. The agent still has its full context.",
  "Tags, pins, PR links, queued messages, scheduled tasks, child threads and model or mode settings stay behind.",
  "It opens in the matching checkout on the other machine, not in a worktree.",
] as const;

/** Why the thread menu offers "Move to machine…" disabled, or null when it is enabled. */
export function moveThreadMenuReason(input: {
  readonly canOperate: boolean;
  readonly machineTransfers: boolean | null;
  readonly isRunning: boolean;
}): string | null {
  if (input.machineTransfers === null) return "Machine not connected";
  if (!input.canOperate) return "No permission to change threads";
  if (!input.machineTransfers) return "Server cannot move threads";
  if (input.isRunning) return "Stop it first";
  return null;
}

const NO_SESSION = "This thread has no Claude session yet. Send a message first.";

export function moveSourceRefusalCopy(refusal: MachineThreadMoveSource["refusal"]): string | null {
  switch (refusal) {
    case "not-claude":
      return "Only Claude threads can move to another machine.";
    case "no-session":
      return NO_SESSION;
    case "thread-busy":
      return "The thread is working. Stop it first.";
    case null:
      return null;
  }
}

export interface MoveDestinationCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly machineTransfers: boolean | null;
  readonly peerLinks: PeerLinkSupport;
  readonly links: PeerLinkListState;
  /** This client may start a receive there (`orchestration:operate` and `source-control:write`). */
  readonly canReceive: boolean;
}

export interface MoveDestination {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Null when the thread can move there. */
  readonly reason: string | null;
}

/** Every machine but the source, each with why the thread cannot move there, if it cannot. */
export function moveDestinations(
  source: { readonly environmentId: EnvironmentId; readonly label: string },
  machines: ReadonlyArray<MoveDestinationCandidate>,
  now: DateTime.Utc,
): ReadonlyArray<MoveDestination> {
  return machines
    .filter((machine) => machine.environmentId !== source.environmentId)
    .map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label,
      reason: destinationReason(source, machine, now),
    }));
}

function destinationReason(
  source: { readonly environmentId: EnvironmentId; readonly label: string },
  machine: MoveDestinationCandidate,
  now: DateTime.Utc,
): string | null {
  if (!machine.connected) return "Not connected.";
  if (machine.machineTransfers !== true) return "Its server cannot receive threads.";
  if (machine.peerLinks === "off") return "Linked environments is off there.";
  if (machine.peerLinks !== "on") return "Its server cannot link to other machines.";
  if (!machine.canReceive) return "No permission to receive threads there.";
  switch (machine.links.kind) {
    case "loading":
      return "Loading its links.";
    case "failed":
      return `Could not read its links: ${machine.links.message}`;
    case "unavailable":
      return "No permission to read its links.";
    case "ready": {
      const link = machine.links.links.find((item) => item.environmentId === source.environmentId);
      if (link === undefined) return `No link from ${machine.label} to ${source.label}.`;
      const view = peerLinkView(link, now);
      return view.live ? null : `Link to ${source.label}: ${view.status}.`;
    }
  }
}

function receiveInput(
  source: MachineThreadMoveSource,
  sessionId: string,
  sourceEnvironmentId: EnvironmentId,
  copyWorkingTree: boolean,
): MachineReceiveInput {
  return {
    sourceEnvironmentId,
    sourceProjectId: source.projectId,
    ...(source.worktreePath === null ? {} : { sourceWorktreePath: source.worktreePath }),
    sessionIds: [sessionId],
    workingTree: copyWorkingTree ? "auto" : "none",
  };
}

/** How a finished receive went for one session of a moving thread. */
type MoveOutcome =
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "moved";
      readonly destinationThreadId: ThreadId;
      /** The destination thread was archived by an earlier move off that machine: bring it back. */
      readonly unarchive: boolean;
    };

/**
 * A session that already belongs to a thread there counts as a move only when an earlier move
 * archived that thread for this very thread (moving back); any other owner is a real conflict.
 */
export function moveOutcome(
  report: MachineTransferReport,
  input: {
    readonly sessionId: string;
    readonly sourceEnvironmentId: EnvironmentId;
    readonly sourceThreadId: ThreadId;
    readonly destinationMoves: ReadonlyArray<MachineThreadMove>;
  },
): MoveOutcome {
  if (report.status === "failed") {
    return { kind: "failed", message: report.error ?? "The transfer failed." };
  }
  const session = report.sessions.find((item) => item.sessionId === input.sessionId);
  if (session === undefined) return { kind: "failed", message: "The session was not copied." };
  const movedAway = (threadId: ThreadId) =>
    input.destinationMoves.some((move) => move.threadId === threadId);
  const movedBack = (threadId: ThreadId) =>
    input.destinationMoves.some(
      (move) =>
        move.threadId === threadId &&
        move.destinationEnvironmentId === input.sourceEnvironmentId &&
        move.destinationThreadId === input.sourceThreadId,
    );
  switch (session.status) {
    case "imported":
    case "updated":
    case "existing-thread":
      return session.threadId === null
        ? { kind: "failed", message: "The session was copied without a thread." }
        : {
            kind: "moved",
            destinationThreadId: session.threadId,
            unarchive: movedAway(session.threadId),
          };
    case "conflict":
      return session.threadId !== null && movedBack(session.threadId)
        ? { kind: "moved", destinationThreadId: session.threadId, unarchive: true }
        : {
            kind: "failed",
            message: session.reason ?? "Another thread there already owns this session.",
          };
    case "busy":
      return { kind: "failed", message: "The thread is working. Stop it first." };
    case "skipped":
      return { kind: "failed", message: session.reason ?? "The session was skipped." };
  }
}

export type Step<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

/** The I/O a move needs, injected so the flow is testable. */
export interface MoveSteps {
  /** Runs a receive on the destination and resolves once its report settles. */
  readonly transfer: (input: MachineReceiveInput) => Promise<Step<MachineTransferReport>>;
  readonly destinationMoves: () => Promise<Step<ReadonlyArray<MachineThreadMove>>>;
  readonly setTitle: (threadId: ThreadId, title: string) => Promise<Step<unknown>>;
  readonly unarchive: (threadId: ThreadId) => Promise<Step<unknown>>;
  readonly markMoved: (input: {
    readonly sourceThreadId: ThreadId;
    readonly destinationThreadId: ThreadId;
    readonly transferId: string;
  }) => Promise<Step<unknown>>;
}

/** What remains after the copy: bring an archived destination back, then archive the source. */
export interface MoveFinish {
  readonly sourceThreadId: ThreadId;
  readonly destinationThreadId: ThreadId;
  readonly transferId: string;
  readonly unarchive: boolean;
}

type MoveRunResult =
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly report: MachineTransferReport | null;
    }
  /** Copied, but the original is still active; `finish` retries the rest. */
  | {
      readonly kind: "copied";
      readonly message: string;
      readonly report: MachineTransferReport;
      readonly finish: MoveFinish;
    }
  | {
      readonly kind: "moved";
      readonly report: MachineTransferReport;
      readonly destinationThreadId: ThreadId;
    };

export async function finishMove(
  finish: MoveFinish,
  steps: Pick<MoveSteps, "unarchive" | "markMoved">,
): Promise<Step<null>> {
  if (finish.unarchive) {
    const unarchived = await steps.unarchive(finish.destinationThreadId);
    if (!unarchived.ok) return unarchived;
  }
  const marked = await steps.markMoved(finish);
  return marked.ok ? { ok: true, value: null } : marked;
}

async function settleSession(
  report: MachineTransferReport,
  thread: {
    readonly sourceThreadId: ThreadId;
    readonly sessionId: string;
    readonly title: string;
  },
  sourceEnvironmentId: EnvironmentId,
  moves: Step<ReadonlyArray<MachineThreadMove>>,
  steps: MoveSteps,
): Promise<MoveRunResult> {
  const outcome = moveOutcome(report, {
    sessionId: thread.sessionId,
    sourceEnvironmentId,
    sourceThreadId: thread.sourceThreadId,
    destinationMoves: moves.ok ? moves.value : [],
  });
  if (outcome.kind === "failed") {
    const message = moves.ok ? outcome.message : `${outcome.message} ${moves.message}`;
    return { kind: "failed", message, report };
  }
  // Best effort: the import already carries the session's own title.
  await steps.setTitle(outcome.destinationThreadId, thread.title);
  const finish: MoveFinish = {
    sourceThreadId: thread.sourceThreadId,
    destinationThreadId: outcome.destinationThreadId,
    transferId: report.transferId,
    unarchive: outcome.unarchive,
  };
  const finished = await finishMove(finish, steps);
  return finished.ok
    ? { kind: "moved", report, destinationThreadId: outcome.destinationThreadId }
    : { kind: "copied", message: finished.message, report, finish };
}

/** Copies one thread's session to the destination, then retires the original. */
export async function runMoveThread(
  input: {
    readonly source: MachineThreadMoveSource;
    readonly sourceEnvironmentId: EnvironmentId;
    readonly title: string;
    readonly copyWorkingTree: boolean;
  },
  steps: MoveSteps,
): Promise<MoveRunResult> {
  const { source } = input;
  const refusal = moveSourceRefusalCopy(source.refusal);
  if (refusal !== null || source.sessionId === null) {
    return { kind: "failed", message: refusal ?? NO_SESSION, report: null };
  }
  const received = await steps.transfer(
    receiveInput(source, source.sessionId, input.sourceEnvironmentId, input.copyWorkingTree),
  );
  if (!received.ok) return { kind: "failed", message: received.message, report: null };
  const moves = await steps.destinationMoves();
  return settleSession(
    received.value,
    { sourceThreadId: source.threadId, sessionId: source.sessionId, title: input.title },
    input.sourceEnvironmentId,
    moves,
    steps,
  );
}

const MAX_SESSIONS_PER_RECEIVE = 20;

export interface MoveAllThread {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly isRunning: boolean;
  /** Null while loading. */
  readonly source:
    | { readonly ok: true; readonly value: MachineThreadMoveSource }
    | { readonly ok: false; readonly message: string }
    | null;
}

interface MoveAllBatch {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly threads: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly title: string;
    readonly sessionId: string;
  }>;
}

interface MoveAllPlan {
  readonly batches: ReadonlyArray<MoveAllBatch>;
  readonly skipped: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly title: string;
    readonly reason: string;
  }>;
  readonly loading: number;
}

/** Idle Claude threads grouped by checkout, at most 20 per receive; the rest with why. */
export function planMoveAll(threads: ReadonlyArray<MoveAllThread>): MoveAllPlan {
  const groups = new Map<
    string,
    {
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
      readonly threads: Array<MoveAllBatch["threads"][number]>;
    }
  >();
  const skipped: Array<MoveAllPlan["skipped"][number]> = [];
  let loading = 0;
  for (const thread of threads) {
    const skip = (reason: string) =>
      skipped.push({ threadId: thread.threadId, title: thread.title, reason });
    if (thread.isRunning) {
      skip("Working. Stop it first.");
      continue;
    }
    if (thread.source === null) {
      loading += 1;
      continue;
    }
    if (!thread.source.ok) {
      skip(thread.source.message);
      continue;
    }
    const source = thread.source.value;
    const refusal = moveSourceRefusalCopy(source.refusal);
    if (refusal !== null || source.sessionId === null) {
      skip(refusal ?? NO_SESSION);
      continue;
    }
    const key = `${source.projectId}\n${source.worktreePath ?? ""}`;
    const group = groups.get(key) ?? {
      projectId: source.projectId,
      worktreePath: source.worktreePath,
      threads: [],
    };
    group.threads.push({
      threadId: thread.threadId,
      title: thread.title,
      sessionId: source.sessionId,
    });
    groups.set(key, group);
  }
  const batches = [...groups.values()].flatMap(({ projectId, worktreePath, threads: group }) => {
    const chunks: Array<MoveAllBatch> = [];
    for (let index = 0; index < group.length; index += MAX_SESSIONS_PER_RECEIVE) {
      chunks.push({
        projectId,
        worktreePath,
        threads: group.slice(index, index + MAX_SESSIONS_PER_RECEIVE),
      });
    }
    return chunks;
  });
  return { batches, skipped, loading };
}

export type MoveAllThreadResult =
  | { readonly kind: "moved"; readonly destinationThreadId: ThreadId }
  | { readonly kind: "copied"; readonly message: string; readonly finish: MoveFinish }
  | { readonly kind: "failed"; readonly message: string };

/** One receive per batch, then each thread settled on its own; a failure never stops the rest. */
export async function runMoveAll(
  batches: ReadonlyArray<MoveAllBatch>,
  sourceEnvironmentId: EnvironmentId,
  steps: MoveSteps,
  onResult: (threadId: ThreadId, result: MoveAllThreadResult) => void,
): Promise<void> {
  for (const batch of batches) {
    const received = await steps.transfer({
      sourceEnvironmentId,
      sourceProjectId: batch.projectId,
      ...(batch.worktreePath === null ? {} : { sourceWorktreePath: batch.worktreePath }),
      sessionIds: batch.threads.map((thread) => thread.sessionId),
      workingTree: "none",
    });
    if (!received.ok) {
      for (const thread of batch.threads) {
        onResult(thread.threadId, { kind: "failed", message: received.message });
      }
      continue;
    }
    const moves = await steps.destinationMoves();
    for (const thread of batch.threads) {
      const result = await settleSession(
        received.value,
        { sourceThreadId: thread.threadId, sessionId: thread.sessionId, title: thread.title },
        sourceEnvironmentId,
        moves,
        steps,
      );
      onResult(
        thread.threadId,
        result.kind === "moved"
          ? { kind: "moved", destinationThreadId: result.destinationThreadId }
          : result.kind === "copied"
            ? { kind: "copied", message: result.message, finish: result.finish }
            : { kind: "failed", message: result.message },
      );
    }
  }
}
