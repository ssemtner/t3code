import {
  ProjectId,
  type MachineCheckoutDescription,
  type MachineWorkingTreeEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { compareCheckouts } from "@t3tools/shared/machinesCheckout";
import {
  pickDestinationProject,
  planWorkingTree,
  transcriptMappings,
  workingTreeReportFields,
} from "./MachinesPlan.ts";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const ROOT = "d".repeat(40);

const checkout = (
  overrides: Partial<MachineCheckoutDescription> = {},
): MachineCheckoutDescription => ({
  head: HEAD,
  branch: "main",
  upstream: null,
  remotes: [],
  rootCommits: [ROOT],
  entries: [],
  stashes: [],
  ...overrides,
});

const entry = (
  path: string,
  kind: MachineWorkingTreeEntry["kind"] = "modified",
  blobId = "1".repeat(40),
): MachineWorkingTreeEntry => ({ path, kind, mode: "100644", blobId });

describe("planWorkingTree", () => {
  const changed = [entry("src/a.rs")];
  const safe = {
    mode: "auto",
    source: changed,
    destination: [entry("notes.md", "untracked")],
    destinationHead: HEAD,
    busy: false,
    safetyRefExists: false,
    received: [],
  } as const;

  it.each([
    ["none requested", { ...safe, mode: "none", busy: true }, "skipped", "not-requested"],
    ["refs only requested", { ...safe, mode: "refs-only", busy: true }, "refs-only", "requested"],
    [
      "a clean source",
      { ...safe, source: [], destinationHead: OTHER },
      "refs-only",
      "nothing-to-apply",
    ],
    [
      "another destination HEAD",
      { ...safe, destinationHead: OTHER, busy: true },
      "refs-only",
      "different-head",
    ],
    [
      "a path changed differently",
      { ...safe, destination: [entry("src/a.rs", "modified", "2".repeat(40))], busy: true },
      "refs-only",
      "destination-changes",
    ],
    [
      "a tracked change only on the destination",
      { ...safe, destination: [entry("src/b.rs")], safetyRefExists: true },
      "refs-only",
      "destination-changes",
    ],
    [
      "the destination's paths still as the last transfer left them",
      {
        ...safe,
        destination: [entry("src/a.rs", "modified", "2".repeat(40)), entry("src/b.rs")],
        received: ["src/a.rs", "src/b.rs"],
      },
      "apply",
      "safe",
    ],
    [
      "a path changed since the last transfer",
      {
        ...safe,
        destination: [entry("src/a.rs", "modified", "2".repeat(40)), entry("src/b.rs")],
        received: ["src/b.rs"],
      },
      "refs-only",
      "destination-changes",
    ],
    [
      "a busy checkout",
      { ...safe, busy: true, safetyRefExists: true },
      "refs-only",
      "checkout-busy",
    ],
    ["an existing safety ref", { ...safe, safetyRefExists: true }, "applied", "already-applied"],
    ["nothing in the way", safe, "apply", "safe"],
  ] as const)("decides with %s", (_, row, action, reason) => {
    const source = checkout({ entries: row.source });
    const destination = checkout({ head: row.destinationHead, entries: row.destination });
    expect(
      planWorkingTree({
        mode: row.mode,
        comparison: compareCheckouts(source, destination, {
          bUnchangedSinceReceived: new Set<string>(row.received),
        }),
        source,
        destinationHead: row.destinationHead,
        snapshotParent: HEAD,
        busy: row.busy,
        safetyRefExists: row.safetyRefExists,
      }),
    ).toEqual({ action, reason });
  });
});

describe("workingTreeReportFields", () => {
  it("counts, orders blocking paths first and caps the path list", () => {
    const shared = Array.from({ length: 205 }, (_, index) =>
      entry(`same/${String(index).padStart(3, "0")}`),
    );
    const source = checkout({
      entries: [...shared, entry("clash", "modified", "1".repeat(40)), entry("mine")],
      stashes: [{ commit: OTHER, baseCommit: HEAD, subject: "wip" }],
    });
    const destination = checkout({
      branch: null,
      entries: [
        ...shared,
        entry("clash", "modified", "2".repeat(40)),
        entry("theirs"),
        entry("scratch", "untracked"),
      ],
    });

    const fields = workingTreeReportFields({
      comparison: compareCheckouts(source, destination),
      source,
      destination,
      action: "refs-only",
      reason: "destination-changes",
    });

    expect(fields).toMatchObject({
      source: { head: HEAD, branch: "main", upstream: null },
      destination: { head: HEAD, branch: null, upstream: null },
      headRelation: "same",
      counts: { identical: 205, onlySource: 1, onlyDestination: 2, differs: 1, unknown: 0 },
      stashes: { both: 0, onlySource: 1, onlyDestination: 0 },
      blocking: ["clash", "theirs"],
      truncated: true,
      summary:
        "Applying would overwrite 2 paths changed on the destination, so the source's working tree was imported as refs only.",
    });
    expect(fields.paths).toHaveLength(200);

    const resent = workingTreeReportFields({
      comparison: compareCheckouts(source, destination, {
        bUnchangedSinceReceived: new Set(["clash", "theirs", "same/000"]),
      }),
      source,
      destination,
      action: "applied",
      reason: "safe",
    });
    expect(resent).toMatchObject({
      counts: { identical: 205, onlySource: 2, onlyDestination: 1, differs: 0, unknown: 0 },
      blocking: [],
    });
    expect(resent.paths.slice(0, 2)).toEqual([
      { path: "clash", status: "only-source", sourceKind: "modified", destinationKind: null },
      { path: "mine", status: "only-source", sourceKind: "modified", destinationKind: null },
    ]);
    expect(fields.paths.slice(0, 4)).toEqual([
      { path: "clash", status: "differs", sourceKind: "modified", destinationKind: "modified" },
      { path: "theirs", status: "only-destination", sourceKind: null, destinationKind: "modified" },
      { path: "mine", status: "only-source", sourceKind: "modified", destinationKind: null },
      {
        path: "scratch",
        status: "only-destination",
        sourceKind: null,
        destinationKind: "untracked",
      },
    ]);
  });
});

describe("transcriptMappings", () => {
  const base = {
    sourceRoots: ["/Users/ssemtner/Developer/robotics/Repo"],
    sourceCheckoutRoot: "/Users/ssemtner/Developer/robotics/Repo",
    destinationRoot: "/home/sjsem/developer/robotics/Repo",
    sourceHome: "/Users/ssemtner",
    destinationHome: "/home/sjsem",
    sourceClaudeConfigDir: "/Users/ssemtner/.claude",
    destinationClaudeConfigDir: "/home/sjsem/.claude",
  };

  it("maps touched roots, shared-tail ancestors, then homes", () => {
    expect(
      transcriptMappings({
        ...base,
        sourceRoots: [
          "/Users/ssemtner/Developer/robotics/Repo/",
          "/Users/ssemtner/.t3/worktrees/Repo/feature",
          "/Users/ssemtner/Developer/robotics/Repo",
        ],
      }),
    ).toEqual([
      {
        from: "/Users/ssemtner/.t3/worktrees/Repo/feature",
        to: "/home/sjsem/developer/robotics/Repo",
      },
      {
        from: "/Users/ssemtner/Developer/robotics/Repo",
        to: "/home/sjsem/developer/robotics/Repo",
      },
      { from: "/Users/ssemtner/Developer/robotics", to: "/home/sjsem/developer/robotics" },
      { from: "/Users/ssemtner/Developer", to: "/home/sjsem/developer" },
      { from: "/Users/ssemtner", to: "/home/sjsem" },
    ]);
  });

  it("maps a Claude config dir that the home mapping does not cover", () => {
    expect(
      transcriptMappings({ ...base, destinationClaudeConfigDir: "/home/sjsem/.config/claude" }),
    ).toContainEqual({ from: "/Users/ssemtner/.claude", to: "/home/sjsem/.config/claude" });
  });

  it("stops at a home directory's parent", () => {
    expect(
      transcriptMappings({
        ...base,
        sourceRoots: ["/Users/ssemtner/Repo"],
        sourceCheckoutRoot: "/Users/ssemtner/Repo",
        destinationRoot: "/data/Users/ssemtner/Repo",
        destinationHome: "/data/Users/ssemtner",
        destinationClaudeConfigDir: "/data/Users/ssemtner/.claude",
      }),
    ).toEqual([
      { from: "/Users/ssemtner/Repo", to: "/data/Users/ssemtner/Repo" },
      { from: "/Users/ssemtner", to: "/data/Users/ssemtner" },
    ]);
  });

  it("emits nothing for identical homes and roots", () => {
    expect(
      transcriptMappings({
        ...base,
        destinationRoot: base.sourceCheckoutRoot,
        destinationHome: base.sourceHome,
        destinationClaudeConfigDir: base.sourceClaudeConfigDir,
      }),
    ).toEqual([]);
  });

  it("maps only the roots when homes are identical", () => {
    expect(
      transcriptMappings({
        ...base,
        destinationRoot: "/Users/ssemtner/code/Repo",
        destinationHome: base.sourceHome,
        destinationClaudeConfigDir: base.sourceClaudeConfigDir,
      }),
    ).toEqual([
      { from: "/Users/ssemtner/Developer/robotics/Repo", to: "/Users/ssemtner/code/Repo" },
    ]);
  });
});

describe("pickDestinationProject", () => {
  const repo = { remotes: [], rootCommits: [ROOT] };
  const unrelated = { remotes: [], rootCommits: [OTHER] };
  const project = (id: string, root: string, identity: typeof repo | null = repo) => ({
    projectId: ProjectId.make(id),
    root,
    identity,
  });
  const source = { root: "/Users/ssemtner/Developer/Repo", identity: repo };

  it.each([
    [
      "no related project",
      [project("a", "/x/Repo", unrelated), project("b", "/y", null)],
      { kind: "none" },
    ],
    [
      "one related project",
      [project("a", "/x/other"), project("b", "/y/Repo", unrelated)],
      { kind: "match", projectId: "a" },
    ],
    [
      "several, one named like the source",
      [project("a", "/x/fork"), project("b", "/y/repo")],
      { kind: "match", projectId: "b" },
    ],
    [
      "several, none named like the source",
      [project("a", "/x/fork"), project("b", "/y/copy")],
      { kind: "ambiguous", candidates: ["a", "b"] },
    ],
    [
      "several named like the source",
      [project("a", "/x/Repo"), project("b", "/y/Repo")],
      { kind: "ambiguous", candidates: ["a", "b"] },
    ],
  ] as const)("picks with %s", (_, projects, expected) => {
    expect(pickDestinationProject({ source, projects, workingTree: true })).toEqual(expected);
  });

  it("accepts a requested project only when it can receive the working tree", () => {
    const projects = [project("same", "/x/Repo"), project("other", "/y/Repo", unrelated)];
    const pick = (requested: string, workingTree: boolean) =>
      pickDestinationProject({
        source,
        projects,
        requestedProjectId: ProjectId.make(requested),
        workingTree,
      });
    expect(pick("same", true)).toEqual({ kind: "match", projectId: "same" });
    expect(pick("other", true)).toEqual({
      kind: "rejected",
      projectId: "other",
      reason: "different-repository",
    });
    expect(pick("other", false)).toEqual({ kind: "match", projectId: "other" });
    expect(pick("gone", false)).toEqual({
      kind: "rejected",
      projectId: "gone",
      reason: "not-found",
    });
  });
});
