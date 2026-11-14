import {
  EnvironmentId,
  type MachineCheckoutDescription,
  MachineRequestRefusedError,
  type MachineSurveyProject,
  type MachineTransferReport,
  type MachineWorkingTreeReport,
  type PeerLinkSummary,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  checkoutFacts,
  comparePreview,
  copyWorkBlockReason,
  groupRepositories,
  localImportBlockReason,
  receiveBlockReason,
  type TransferEnd,
  transferFailureMessage,
  transferReportView,
} from "./MachinesRepos.logic";

const now = DateTime.makeUnsafe("2026-11-13T12:00:00.000Z");
const laptop = EnvironmentId.make("env-laptop");
const desk = EnvironmentId.make("env-desk");

const remote = (canonicalKey: string) => ({
  name: "origin",
  url: `git@github.com:${canonicalKey}.git`,
  canonicalKey,
});

const project = (
  id: string,
  overrides: Partial<MachineSurveyProject> & { readonly remoteKey?: string | null } = {},
): MachineSurveyProject => {
  const { remoteKey = "acme/app", ...rest } = overrides;
  const projectId = ProjectId.make(id);
  return {
    projectId,
    title: id,
    workspaceRoot: `/home/me/${id}`,
    checkout:
      remoteKey === null
        ? null
        : {
            projectId,
            projectRoot: `/home/me/${id}`,
            checkoutRoot: `/home/me/${id}`,
            head: "a".repeat(40),
            branch: "main",
            remotes: [remote(remoteKey)],
            rootCommits: [`root-${remoteKey}`],
          },
    checkoutError: null,
    sessions: [],
    sessionsTruncated: false,
    recentTransfers: [],
    ...rest,
  };
};

const session = (sessionId: string, existingThreadId: string | null) => ({
  sessionId,
  title: sessionId,
  firstTimestamp: null,
  lastTimestamp: null,
  size: 1,
  lineCount: 1,
  projectDirName: "dir",
  firstCwd: null,
  filedElsewhere: false,
  roots: [],
  existingThreadId: existingThreadId === null ? null : ThreadId.make(existingThreadId),
});

const description = (
  overrides: Partial<MachineCheckoutDescription> = {},
): MachineCheckoutDescription => ({
  head: "a".repeat(40),
  branch: "main",
  upstream: { ref: "origin/main", ahead: 0, behind: 0 },
  remotes: [remote("acme/app")],
  rootCommits: ["root-acme/app"],
  entries: [],
  stashes: [],
  ...overrides,
});

describe("groupRepositories", () => {
  it("puts one repository on two machines in one row, first, and skips non-git projects", () => {
    const rows = groupRepositories([
      {
        environmentId: laptop,
        label: "laptop",
        survey: {
          projects: [
            project("app", { sessions: [session("s1", null), session("s2", "thread-2")] }),
            project("notes", { remoteKey: "me/notes" }),
            project("scratch", { remoteKey: null }),
          ],
        },
      },
      {
        environmentId: desk,
        label: "desk",
        survey: { projects: [project("app-clone"), project("zeta", { remoteKey: "me/zeta" })] },
      },
    ]);
    expect(rows.map((row) => [row.title, row.cells.map((cell) => cell.machineLabel)])).toEqual([
      ["app", ["laptop", "desk"]],
      ["notes", ["laptop"]],
      ["zeta", ["desk"]],
    ]);
    expect(rows[0]!.cells[0]!.pendingSessions.map((entry) => entry.sessionId)).toEqual(["s1"]);
  });
});

describe("checkoutFacts", () => {
  it("summarizes branch, head, upstream and dirty entries by kind", () => {
    const facts = checkoutFacts(
      description({
        upstream: { ref: "origin/main", ahead: 2, behind: 1 },
        entries: [
          { path: "a.ts", kind: "modified", mode: null, blobId: null },
          { path: "b.ts", kind: "modified", mode: null, blobId: null },
          { path: "c.ts", kind: "untracked", mode: null, blobId: null },
        ],
      }),
    );
    expect(facts).toMatchObject({
      branch: "main",
      shortHead: "aaaaaaa",
      upstream: "2 ahead, 1 behind origin/main",
      dirtyTotal: 3,
      dirtyText: "2 modified, 1 untracked",
    });
    expect(checkoutFacts(description({ branch: null, upstream: null })).branch).toBe("detached");
    expect(
      checkoutFacts(description({ upstream: { ref: "origin/x", ahead: null, behind: null } }))
        .upstream,
    ).toBe("origin/x (gone)");
  });
});

describe("comparePreview", () => {
  it("names each side and cannot tell one-sided paths apart across different commits", () => {
    const a = description({
      entries: [{ path: "a.ts", kind: "modified", mode: "100644", blobId: "1" }],
    });
    const same = comparePreview(a, description(), { a: "laptop", b: "desk" });
    expect(same.head).toBe("Same commit.");
    expect(same.paths).toEqual([{ path: "a.ts", status: "Only on laptop" }]);
    const moved = comparePreview(a, description({ head: "b".repeat(40) }), {
      a: "laptop",
      b: "desk",
    });
    expect(moved.paths).toEqual([{ path: "a.ts", status: "Changed on one side" }]);
  });
});

const link = (environmentId: EnvironmentId, expiresAt: string): PeerLinkSummary => ({
  environmentId,
  label: environmentId,
  urls: ["https://peer.example.ts.net"],
  access: "approval-required",
  linkedAt: DateTime.makeUnsafe("2026-11-01T12:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe(expiresAt),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
});

const end = (environmentId: EnvironmentId, overrides: Partial<TransferEnd> = {}): TransferEnd => ({
  environmentId,
  label: environmentId.replace("env-", ""),
  connected: true,
  peerLinks: "on",
  links: { kind: "ready", links: [] },
  canReceive: true,
  machineTransfers: true,
  canCreateThreads: true,
  ...overrides,
});

describe("receiveBlockReason", () => {
  const source = end(laptop);
  it.each([
    ["no link", end(desk), "desk is not linked to laptop."],
    [
      "an expired link",
      end(desk, {
        links: { kind: "ready", links: [link(laptop, "2026-11-10T12:00:00.000Z")] },
      }),
      "desk's link to laptop does not work. Link them again.",
    ],
    ["links off", end(desk, { peerLinks: "off" }), "Linked environments is off on desk."],
    ["no permission", end(desk, { canReceive: false }), "No permission to receive on desk."],
    ["disconnected", end(desk, { connected: false }), "desk is not connected."],
  ])("blocks %s", (_, destination, reason) => {
    expect(receiveBlockReason(source, destination, now)).toBe(reason);
  });

  it("allows a live link, and leaves unread links to the server", () => {
    const live = end(desk, {
      links: { kind: "ready", links: [link(laptop, "2026-12-30T12:00:00.000Z")] },
    });
    expect(receiveBlockReason(source, live, now)).toBeNull();
    expect(receiveBlockReason(source, end(desk, { links: { kind: "unavailable" } }), now)).toBe(
      null,
    );
  });

  it("needs uncommitted work on the source to copy it", () => {
    const destination = end(desk, { links: { kind: "unavailable" } });
    expect(copyWorkBlockReason(source, destination, checkoutFacts(description()), now)).toBe(
      "Nothing uncommitted on laptop.",
    );
    expect(copyWorkBlockReason(source, destination, null, now)).toBe("Loading laptop's checkout…");
  });
});

describe("localImportBlockReason", () => {
  it.each([
    ["disconnected", end(desk, { connected: false }), "desk is not connected."],
    [
      "a server without transfers",
      end(desk, { machineTransfers: false }),
      "desk's server cannot import sessions. Update it.",
    ],
    [
      "no permission",
      end(desk, { canCreateThreads: false }),
      "No permission to create threads on desk.",
    ],
  ])("blocks %s", (_, machine, reason) => {
    expect(localImportBlockReason(machine)).toBe(reason);
  });

  it("needs no link, receive permission or source: the session is already there", () => {
    expect(
      localImportBlockReason(
        end(desk, { peerLinks: "off", canReceive: false, links: { kind: "unavailable" } }),
      ),
    ).toBeNull();
  });
});

const workingTree = (
  overrides: Partial<MachineWorkingTreeReport> = {},
): MachineWorkingTreeReport => ({
  action: "applied",
  reason: "safe",
  source: { head: null, branch: null, upstream: null },
  destination: { head: null, branch: null, upstream: null },
  headRelation: "same",
  mergeBase: null,
  importedRefs: null,
  safetyRef: "refs/t3/safety",
  counts: { identical: 0, onlySource: 1, onlyDestination: 0, differs: 0, unknown: 0 },
  stashes: { both: 0, onlySource: 0, onlyDestination: 0 },
  blocking: [],
  paths: [],
  truncated: false,
  summary: "1 file copied",
  ...overrides,
});

const report = (overrides: Partial<MachineTransferReport> = {}): MachineTransferReport => ({
  transferId: "t-1",
  status: "completed",
  phase: "done",
  sourceEnvironmentId: laptop,
  destination: { projectId: ProjectId.make("app"), root: "/home/me/app" },
  workingTree: null,
  sessions: [],
  undo: { available: false, undoneAt: null },
  error: null,
  ...overrides,
});

describe("transferReportView", () => {
  it("lists blocking paths and kept refs when the destination has its own changes", () => {
    const view = transferReportView(
      report({
        workingTree: workingTree({
          action: "refs-only",
          reason: "destination-changes",
          blocking: ["src/a.ts"],
          importedRefs: { snapshot: "refs/t3/in/t-1", branch: "refs/t3/in/t-1-main" },
        }),
      }),
    );
    expect(view.workingTree).toMatchObject({
      headline: "The destination has its own changes in these files:",
      blocking: ["src/a.ts"],
      refs: ["refs/t3/in/t-1", "refs/t3/in/t-1-main"],
    });
    expect(view.canUndo).toBe(false);
  });

  it("explains a different head with the relation, and hides an unrequested tree", () => {
    const view = transferReportView(
      report({
        workingTree: workingTree({
          action: "refs-only",
          reason: "different-head",
          headRelation: "diverged",
        }),
      }),
    );
    expect(view.workingTree?.headRelation).toBe("The two branches have diverged.");
    expect(
      transferReportView(report({ workingTree: workingTree({ reason: "not-requested" }) }))
        .workingTree,
    ).toBeNull();
  });

  it("shows the phase while running, the error on failure, and undo only once", () => {
    expect(transferReportView(report({ status: "running", phase: "Downloading" })).headline).toBe(
      "Downloading",
    );
    expect(transferReportView(report({ status: "failed", error: "Disk full" }))).toMatchObject({
      tone: "failed",
      headline: "Disk full",
    });
    expect(transferReportView(report({ undo: { available: true, undoneAt: null } })).canUndo).toBe(
      true,
    );
    expect(
      transferReportView(
        report({ undo: { available: true, undoneAt: "2026-11-13T12:00:00.000Z" } }),
      ),
    ).toMatchObject({ canUndo: false, headline: "Undone." });
  });
});

describe("transferFailureMessage", () => {
  it("shows a refusal's message and a generic one for anything else", () => {
    expect(
      transferFailureMessage(
        new MachineRequestRefusedError({ code: "checkout-busy", message: "An agent is working." }),
      ),
    ).toBe("An agent is working.");
    expect(transferFailureMessage({ weird: true })).toBe("The request failed. Try again.");
  });
});
