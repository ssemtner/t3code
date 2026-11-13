import {
  EnvironmentId,
  type MachineThreadMove,
  type MachineThreadMoveSource,
  type MachineTransferReport,
  type PeerLinkSummary,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  finishMove,
  type MoveAllThread,
  type MoveDestinationCandidate,
  moveDestinations,
  moveOutcome,
  type MoveSteps,
  planMoveAll,
  runMoveAll,
  runMoveThread,
} from "./moveThread.logic";

const now = DateTime.makeUnsafe("2026-11-13T12:00:00.000Z");
const laptop = EnvironmentId.make("env-laptop");
const desk = EnvironmentId.make("env-desk");
const project = ProjectId.make("project-1");
const original = ThreadId.make("thread-original");
const copy = ThreadId.make("import:claudeAgent:session-1");

const link = (environmentId: EnvironmentId): PeerLinkSummary => ({
  environmentId,
  label: environmentId,
  urls: ["https://peer.example.ts.net"],
  access: "approval-required",
  linkedAt: DateTime.makeUnsafe("2026-11-01T12:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2026-12-01T12:00:00.000Z"),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
});

const candidate = (
  overrides: Partial<MoveDestinationCandidate> = {},
): MoveDestinationCandidate => ({
  environmentId: desk,
  label: "desk",
  connected: true,
  machineTransfers: true,
  peerLinks: "on",
  links: { kind: "ready", links: [link(laptop)] },
  canReceive: true,
  ...overrides,
});

const source = (overrides: Partial<MachineThreadMoveSource> = {}): MachineThreadMoveSource => ({
  threadId: original,
  sessionId: "session-1",
  driver: null,
  projectId: project,
  worktreePath: null,
  checkoutRoot: "/repo",
  idle: true,
  refusal: null,
  ...overrides,
});

const report = (
  sessions: MachineTransferReport["sessions"],
  overrides: Partial<MachineTransferReport> = {},
): MachineTransferReport => ({
  transferId: "t-1",
  status: "completed",
  phase: "done",
  sourceEnvironmentId: laptop,
  destination: { projectId: project, root: "/repo" },
  workingTree: null,
  sessions,
  undo: { available: false, undoneAt: null },
  error: null,
  ...overrides,
});

const pointer = (overrides: Partial<MachineThreadMove> = {}): MachineThreadMove => ({
  threadId: original,
  destinationEnvironmentId: laptop,
  destinationThreadId: copy,
  transferId: "t-0",
  movedAt: "2026-11-12T12:00:00.000Z",
  ...overrides,
});

function fakeSteps(overrides: Partial<MoveSteps> = {}) {
  const calls: Array<string> = [];
  const ok = <A>(value: A) => Promise.resolve({ ok: true as const, value });
  const steps: MoveSteps = {
    transfer: (input) => {
      calls.push(`transfer:${(input.sessionIds ?? []).join(",")}`);
      return ok(
        report(
          (input.sessionIds ?? []).map((sessionId) => ({
            sessionId,
            threadId: ThreadId.make(`import:claudeAgent:${sessionId}`),
            status: "imported" as const,
          })),
        ),
      );
    },
    destinationMoves: () => ok([]),
    setTitle: (threadId, title) => {
      calls.push(`title:${threadId}:${title}`);
      return ok(null);
    },
    unarchive: (threadId) => {
      calls.push(`unarchive:${threadId}`);
      return ok(null);
    },
    markMoved: ({ sourceThreadId, destinationThreadId }) => {
      calls.push(`moved:${sourceThreadId}->${destinationThreadId}`);
      return ok(null);
    },
    ...overrides,
  };
  return { steps, calls };
}

describe("moveDestinations", () => {
  it("leaves out the source and says why each other machine cannot take the thread", () => {
    const destinations = moveDestinations(
      { environmentId: laptop, label: "laptop" },
      [
        candidate({ environmentId: laptop, label: "laptop" }),
        candidate(),
        candidate({ label: "off", connected: false }),
        candidate({ label: "stock", machineTransfers: false }),
        candidate({ label: "beta off", peerLinks: "off" }),
        candidate({ label: "read only", canReceive: false }),
        candidate({ label: "unlinked", links: { kind: "ready", links: [] } }),
        candidate({
          label: "expired",
          links: {
            kind: "ready",
            links: [{ ...link(laptop), expiresAt: DateTime.makeUnsafe("2026-11-10T00:00:00Z") }],
          },
        }),
      ],
      now,
    );
    expect(destinations.map(({ label, reason }) => [label, reason])).toEqual([
      ["desk", null],
      ["off", "Not connected."],
      ["stock", "Its server cannot receive threads."],
      ["beta off", "Linked environments is off there."],
      ["read only", "No permission to receive threads there."],
      ["unlinked", "No link from unlinked to laptop."],
      ["expired", "Link to laptop: Expired."],
    ]);
  });
});

describe("moveOutcome", () => {
  const input = {
    sessionId: "session-1",
    sourceEnvironmentId: laptop,
    sourceThreadId: copy,
    destinationMoves: [] as ReadonlyArray<MachineThreadMove>,
  };

  it("counts an import, and brings back a destination thread an earlier move archived", () => {
    const imported = report([{ sessionId: "session-1", threadId: copy, status: "imported" }]);
    expect(moveOutcome(imported, input)).toEqual({
      kind: "moved",
      destinationThreadId: copy,
      unarchive: false,
    });
    expect(
      moveOutcome(imported, { ...input, destinationMoves: [pointer({ threadId: copy })] }),
    ).toMatchObject({ kind: "moved", unarchive: true });
  });

  it("treats a conflict as moving back only when a pointer names this very thread", () => {
    const conflict = report([
      { sessionId: "session-1", threadId: original, status: "conflict", reason: "Owned." },
    ]);
    expect(moveOutcome(conflict, { ...input, destinationMoves: [pointer()] })).toEqual({
      kind: "moved",
      destinationThreadId: original,
      unarchive: true,
    });
    expect(moveOutcome(conflict, input)).toEqual({ kind: "failed", message: "Owned." });
    expect(
      moveOutcome(conflict, {
        ...input,
        destinationMoves: [pointer({ destinationThreadId: ThreadId.make("other") })],
      }),
    ).toEqual({ kind: "failed", message: "Owned." });
  });

  it("fails on a failed transfer, a busy session or a missing one", () => {
    expect(moveOutcome(report([], { status: "failed", error: "Source gone." }), input)).toEqual({
      kind: "failed",
      message: "Source gone.",
    });
    expect(
      moveOutcome(report([{ sessionId: "session-1", threadId: null, status: "busy" }]), input),
    ).toEqual({ kind: "failed", message: "The thread is working. Stop it first." });
    expect(moveOutcome(report([]), input).kind).toBe("failed");
  });
});

describe("runMoveThread", () => {
  const run = (steps: MoveSteps, overrides: Partial<MachineThreadMoveSource> = {}) =>
    runMoveThread(
      {
        source: source(overrides),
        sourceEnvironmentId: laptop,
        title: "Fix login",
        copyWorkingTree: false,
      },
      steps,
    );

  it("copies, titles, then archives the original", async () => {
    const { steps, calls } = fakeSteps();
    const result = await run(steps);
    expect(result).toMatchObject({ kind: "moved", destinationThreadId: copy });
    expect(calls).toEqual([
      "transfer:session-1",
      `title:${copy}:Fix login`,
      `moved:${original}->${copy}`,
    ]);
  });

  it("refuses a busy or non-Claude thread without copying anything", async () => {
    const { steps, calls } = fakeSteps();
    expect(await run(steps, { refusal: "thread-busy", idle: false })).toEqual({
      kind: "failed",
      message: "The thread is working. Stop it first.",
      report: null,
    });
    expect((await run(steps, { refusal: "not-claude" })).kind).toBe("failed");
    expect(calls).toEqual([]);
  });

  it("keeps the copy and offers the rest again when archiving the original fails", async () => {
    const { steps } = fakeSteps({
      markMoved: () => Promise.resolve({ ok: false, message: "Offline." }),
    });
    const result = await run(steps);
    expect(result).toMatchObject({
      kind: "copied",
      message: "Offline.",
      finish: { sourceThreadId: original, destinationThreadId: copy, unarchive: false },
    });
    if (result.kind !== "copied") return;
    const retry = fakeSteps();
    expect(await finishMove(result.finish, retry.steps)).toEqual({ ok: true, value: null });
    expect(retry.calls).toEqual([`moved:${original}->${copy}`]);
  });

  it("moving back unarchives the original before archiving the copy", async () => {
    const { steps, calls } = fakeSteps({
      transfer: () =>
        Promise.resolve({
          ok: true,
          value: report([{ sessionId: "session-1", threadId: original, status: "conflict" }]),
        }),
      destinationMoves: () => Promise.resolve({ ok: true, value: [pointer()] }),
    });
    const result = await runMoveThread(
      {
        source: source({ threadId: copy }),
        sourceEnvironmentId: laptop,
        title: "Fix login",
        copyWorkingTree: false,
      },
      steps,
    );
    expect(result).toMatchObject({ kind: "moved", destinationThreadId: original });
    expect(calls).toEqual([
      `title:${original}:Fix login`,
      `unarchive:${original}`,
      `moved:${copy}->${original}`,
    ]);
  });
});

describe("planMoveAll", () => {
  const thread = (index: number, overrides: Partial<MoveAllThread> = {}): MoveAllThread => ({
    threadId: ThreadId.make(`thread-${index}`),
    title: `Thread ${index}`,
    isRunning: false,
    source: {
      ok: true,
      value: source({ threadId: ThreadId.make(`thread-${index}`), sessionId: `s-${index}` }),
    },
    ...overrides,
  });

  it("groups by checkout in receives of at most 20 and lists the rest with why", () => {
    const plan = planMoveAll([
      ...Array.from({ length: 21 }, (_, index) => thread(index)),
      thread(30, {
        source: {
          ok: true,
          value: source({ sessionId: "s-30", worktreePath: "/repo/.worktrees/a" }),
        },
      }),
      thread(31, { isRunning: true }),
      thread(32, { source: { ok: true, value: source({ refusal: "not-claude" }) } }),
      thread(33, { source: null }),
    ]);
    expect(plan.batches.map((batch) => [batch.worktreePath, batch.threads.length])).toEqual([
      [null, 20],
      [null, 1],
      ["/repo/.worktrees/a", 1],
    ]);
    expect(plan.skipped.map(({ title, reason }) => [title, reason])).toEqual([
      ["Thread 31", "Working. Stop it first."],
      ["Thread 32", "Only Claude threads can move to another machine."],
    ]);
    expect(plan.loading).toBe(1);
  });
});

describe("runMoveAll", () => {
  it("reports each thread and keeps going after a failed receive", async () => {
    let transfers = 0;
    const { steps, calls } = fakeSteps();
    const failingFirst: MoveSteps = {
      ...steps,
      transfer: (input) =>
        transfers++ === 0
          ? Promise.resolve({ ok: false, message: "No link." })
          : steps.transfer(input),
    };
    const results: Array<[string, string]> = [];
    await runMoveAll(
      [
        {
          projectId: project,
          worktreePath: null,
          threads: [{ threadId: ThreadId.make("a"), title: "A", sessionId: "s-a" }],
        },
        {
          projectId: project,
          worktreePath: "/wt",
          threads: [{ threadId: ThreadId.make("b"), title: "B", sessionId: "s-b" }],
        },
      ],
      laptop,
      failingFirst,
      (threadId, result) => results.push([threadId, result.kind]),
    );
    expect(results).toEqual([
      ["a", "failed"],
      ["b", "moved"],
    ]);
    expect(calls).toContain("moved:b->import:claudeAgent:s-b");
  });
});
