import type { MachineCheckoutDescription, MachineWorkingTreeEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { normalizeGitRemoteUrl } from "./git.ts";
import { compareCheckouts, sameRepository } from "./machinesCheckout.ts";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const BASE = "c".repeat(40);
const ROOT = "d".repeat(40);

const remote = (name: string, url: string) => ({
  name,
  url,
  canonicalKey: normalizeGitRemoteUrl(url),
});

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
  blobId: string | null = `${path.length}`.padStart(40, "0"),
  mode: string | null = "100644",
): MachineWorkingTreeEntry => ({ path, kind, mode, blobId });

describe("compareCheckouts", () => {
  it("finds the robot repository's two checkouts convergent", () => {
    const shared = [
      entry("src/main.rs", "modified", "1".repeat(40)),
      entry("src/subsystems/drive.rs", "modified", "2".repeat(40)),
      entry("Cargo.toml", "modified", "3".repeat(40)),
      entry("notes.md", "untracked", "4".repeat(40)),
      entry("src/vision.rs", "untracked", "5".repeat(40)),
      entry("tuning.json", "untracked", "6".repeat(40)),
    ];
    const laptop = checkout({
      remotes: [
        remote("origin", "git@github.com:theholycows/1538_2026_Offseason_Rust.git"),
        remote("personal", "git@github.com:ssemtner/1538_2026_Offseason_Rust.git"),
      ],
      entries: shared,
    });
    const desktop = checkout({
      remotes: [remote("origin", "git@github.com:ssemtner/1538_2026_Offseason_Rust.git")],
      entries: [...shared, entry("Cargo.lock", "modified", "7".repeat(40))],
      stashes: [{ commit: OTHER, baseCommit: BASE, subject: "WIP on main: old" }],
    });

    const comparison = compareCheckouts(laptop, desktop);

    expect(comparison.kinship).toEqual({
      relation: "same-repository",
      sharedRemoteKeys: ["github.com/ssemtner/1538_2026_offseason_rust"],
      sharedRootCommits: [ROOT],
    });
    expect(comparison.head).toBe("same");
    expect(comparison.paths.find((path) => path.path === "Cargo.lock")?.status).toBe("only-b");
    expect(comparison.summary).toEqual({
      paths: { identical: 6, "only-a": 0, "only-b": 1, differs: 0, unknown: 0 },
      stashes: { both: 0, onlyA: 0, onlyB: 1 },
      receivable: { sourceOntoDestination: false, destinationOntoSource: true },
      convergent: true,
    });
  });

  it.each([
    [
      "a shared remote",
      [remote("origin", "https://github.com/o/r")],
      [remote("up", "git@github.com:O/R.git")],
      [],
      "same-repository",
    ],
    ["a shared root commit", [], [], [ROOT], "same-repository"],
    [
      "the same local path",
      [{ ...remote("origin", "/srv/r.git"), canonicalKey: null }],
      [{ ...remote("origin", "/srv/r.git"), canonicalKey: null }],
      [],
      "unrelated",
    ],
    [
      "different remotes",
      [remote("origin", "git@github.com:o/a.git")],
      [remote("origin", "git@github.com:o/b.git")],
      [],
      "unrelated",
    ],
  ])("relates checkouts through %s", (_, aRemotes, bRemotes, roots, relation) => {
    const a = checkout({ remotes: aRemotes, rootCommits: roots });
    const b = checkout({ remotes: bRemotes, rootCommits: roots });
    const comparison = compareCheckouts(a, b);
    expect(comparison.kinship.relation).toBe(relation);
    expect(sameRepository(a, b)).toBe(relation === "same-repository");
    expect(comparison.summary.convergent).toBe(relation === "same-repository");
  });

  it.each([
    ["equal HEADs", HEAD, HEAD, {}, "same"],
    ["a merge base at b", HEAD, OTHER, { mergeBase: OTHER }, "a-ahead"],
    ["a merge base at a", HEAD, OTHER, { mergeBase: HEAD }, "b-ahead"],
    ["a merge base at neither", HEAD, OTHER, { mergeBase: BASE }, "diverged"],
    [
      "neither holding the other's HEAD",
      HEAD,
      OTHER,
      { aHasHeadOfB: false, bHasHeadOfA: false },
      "diverged",
    ],
    [
      "one side holding the other's HEAD",
      HEAD,
      OTHER,
      { aHasHeadOfB: true, bHasHeadOfA: false },
      "unknown",
    ],
    ["no knowledge", HEAD, OTHER, {}, "unknown"],
    ["an unborn HEAD", null, OTHER, {}, "unknown"],
  ] as const)("relates HEADs given %s", (_, aHead, bHead, knowledge, relation) => {
    expect(
      compareCheckouts(checkout({ head: aHead }), checkout({ head: bHead }), knowledge).head,
    ).toBe(relation);
  });

  it.each([
    ["the same change", HEAD, [entry("x")], [entry("x")], "identical"],
    [
      "different content",
      HEAD,
      [entry("x", "modified", "1".repeat(40))],
      [entry("x", "modified", "2".repeat(40))],
      "differs",
    ],
    [
      "a different mode",
      HEAD,
      [entry("x")],
      [entry("x", "modified", undefined, "100755")],
      "differs",
    ],
    ["staged on one side only", HEAD, [entry("x", "added")], [entry("x", "untracked")], "differs"],
    [
      "a deletion on both sides",
      HEAD,
      [entry("x", "deleted", null, null)],
      [entry("x", "deleted", null, null)],
      "identical",
    ],
    ["a change on one side", HEAD, [entry("x")], [], "only-a"],
    ["a change on the other side", HEAD, [], [entry("x")], "only-b"],
    ["a one-sided change across HEADs", OTHER, [entry("x")], [], "unknown"],
    ["the same change across HEADs", OTHER, [entry("x")], [entry("x")], "identical"],
    [
      "different content across HEADs",
      OTHER,
      [entry("x", "modified", "1".repeat(40))],
      [entry("x", "modified", "2".repeat(40))],
      "differs",
    ],
  ] as const)("classifies a path with %s", (_, bHead, aEntries, bEntries, status) => {
    const comparison = compareCheckouts(
      checkout({ entries: aEntries }),
      checkout({ head: bHead, entries: bEntries }),
    );
    expect(comparison.paths.map((path) => path.status)).toEqual([status]);
    expect(comparison.summary.paths[status]).toBe(1);
  });

  it.each([
    ["one-sided changes on the source", [entry("x")], [], true, true, false],
    ["one-sided changes on the destination", [], [entry("x")], true, false, true],
    ["one-sided tracked changes on both sides", [entry("x")], [entry("y")], false, false, false],
    [
      "a tracked change against an untracked file",
      [entry("x")],
      [entry("y", "untracked")],
      true,
      true,
      false,
    ],
    [
      "a conflicting path",
      [entry("x", "modified", "1".repeat(40))],
      [entry("x", "modified", "2".repeat(40))],
      false,
      false,
      false,
    ],
  ] as const)(
    "decides convergence with %s",
    (_, aEntries, bEntries, convergent, sourceOntoDestination, destinationOntoSource) => {
      const { summary } = compareCheckouts(
        checkout({ entries: aEntries }),
        checkout({ entries: bEntries }),
      );
      expect(summary.convergent).toBe(convergent);
      expect(summary.receivable).toEqual({ sourceOntoDestination, destinationOntoSource });
    },
  );

  it("matches stashes by commit", () => {
    const stash = (commit: string) => ({ commit, baseCommit: BASE, subject: commit.slice(0, 1) });
    const comparison = compareCheckouts(
      checkout({ stashes: [stash(HEAD), stash(OTHER)] }),
      checkout({ stashes: [stash(OTHER), stash(ROOT)] }),
    );
    expect(comparison.stashes.map((entry) => [entry.subject, entry.status])).toEqual([
      ["a", "only-a"],
      ["b", "both"],
      ["d", "only-b"],
    ]);
    expect(comparison.summary.stashes).toEqual({ both: 1, onlyA: 1, onlyB: 1 });
    expect(comparison.summary.convergent).toBe(true);
  });
});
