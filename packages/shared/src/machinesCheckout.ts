import type { MachineCheckoutDescription, MachineWorkingTreeEntry } from "@t3tools/contracts";

type HeadRelation = "same" | "a-ahead" | "b-ahead" | "diverged" | "unknown";
type PathStatus = "identical" | "only-a" | "only-b" | "differs" | "unknown";

interface ComparisonKnowledge {
  readonly aHasHeadOfB?: boolean;
  readonly bHasHeadOfA?: boolean;
  /** The merge base of the two HEADs, from a machine that has both. */
  readonly mergeBase?: string;
  /** `b`'s paths that still hold what the last transfer from `a` wrote there: not `b`'s own work. */
  readonly bUnchangedSinceReceived?: ReadonlySet<string>;
}

const intersect = (left: Iterable<string>, right: Iterable<string>) => {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((value) => rightSet.has(value)).sort();
};

type RepositoryKin = Pick<MachineCheckoutDescription, "remotes" | "rootCommits">;

function kinship(a: RepositoryKin, b: RepositoryKin) {
  const sharedRemoteKeys = intersect(
    a.remotes.flatMap((remote) => (remote.canonicalKey === null ? [] : [remote.canonicalKey])),
    b.remotes.flatMap((remote) => (remote.canonicalKey === null ? [] : [remote.canonicalKey])),
  );
  const sharedRootCommits = intersect(a.rootCommits, b.rootCommits);
  const relation =
    sharedRemoteKeys.length > 0 || sharedRootCommits.length > 0 ? "same-repository" : "unrelated";
  return { relation, sharedRemoteKeys, sharedRootCommits };
}

export const sameRepository = (a: RepositoryKin, b: RepositoryKin) =>
  kinship(a, b).relation === "same-repository";

function headRelation(
  a: MachineCheckoutDescription,
  b: MachineCheckoutDescription,
  knowledge: ComparisonKnowledge,
): HeadRelation {
  if (a.head === null || b.head === null) return "unknown";
  if (a.head === b.head) return "same";
  if (knowledge.mergeBase !== undefined) {
    if (knowledge.mergeBase === b.head) return "a-ahead";
    if (knowledge.mergeBase === a.head) return "b-ahead";
    return "diverged";
  }
  // Holding the other HEAD does not make it an ancestor, but lacking it rules that out.
  if (knowledge.aHasHeadOfB === false && knowledge.bHasHeadOfA === false) return "diverged";
  return "unknown";
}

const sameEntry = (a: MachineWorkingTreeEntry, b: MachineWorkingTreeEntry) =>
  a.kind === b.kind && a.mode === b.mode && a.blobId === b.blobId;

export function compareCheckouts(
  a: MachineCheckoutDescription,
  b: MachineCheckoutDescription,
  knowledge: ComparisonKnowledge = {},
) {
  const relatedness = kinship(a, b);
  const head = headRelation(a, b, knowledge);

  const aEntries = new Map(a.entries.map((entry) => [entry.path, entry]));
  const bEntries = new Map(b.entries.map((entry) => [entry.path, entry]));
  const received = knowledge.bUnchangedSinceReceived;
  const paths = [...new Set([...aEntries.keys(), ...bEntries.keys()])].sort().flatMap((path) => {
    const aEntry = aEntries.get(path) ?? null;
    const bListed = bEntries.get(path) ?? null;
    const bEntry =
      bListed !== null &&
      received?.has(path) === true &&
      (aEntry === null || !sameEntry(aEntry, bListed))
        ? null
        : bListed;
    if (aEntry === null && bEntry === null) return [];
    // Against different HEADs, a path listed on one side may still match the other's HEAD.
    const status: PathStatus =
      aEntry !== null && bEntry !== null
        ? sameEntry(aEntry, bEntry)
          ? "identical"
          : "differs"
        : head !== "same"
          ? "unknown"
          : aEntry !== null
            ? "only-a"
            : "only-b";
    return [{ path, status, a: aEntry, b: bEntry }];
  });

  const aStashes = new Set(a.stashes.map((stash) => stash.commit));
  const bStashes = new Set(b.stashes.map((stash) => stash.commit));
  const stashes = [
    ...a.stashes.map((stash) => ({
      ...stash,
      status: bStashes.has(stash.commit) ? ("both" as const) : ("only-a" as const),
    })),
    ...b.stashes
      .filter((stash) => !aStashes.has(stash.commit))
      .map((stash) => ({ ...stash, status: "only-b" as const })),
  ];

  const counts = { identical: 0, "only-a": 0, "only-b": 0, differs: 0, unknown: 0 };
  for (const entry of paths) counts[entry.status]++;
  // Applying one side leaves the other's untracked-only files alone but reverts its other changes,
  // so the receiving side must hold nothing of its own except untracked files.
  const receives = (side: "only-a" | "only-b") =>
    relatedness.relation === "same-repository" &&
    head === "same" &&
    counts.differs === 0 &&
    paths.every(
      (entry) =>
        entry.status !== side || (side === "only-a" ? entry.a : entry.b)?.kind === "untracked",
    );
  const receivable = {
    sourceOntoDestination: receives("only-b"),
    destinationOntoSource: receives("only-a"),
  };
  return {
    kinship: relatedness,
    head,
    paths,
    stashes,
    summary: {
      paths: counts,
      stashes: {
        both: stashes.filter((stash) => stash.status === "both").length,
        onlyA: stashes.filter((stash) => stash.status === "only-a").length,
        onlyB: stashes.filter((stash) => stash.status === "only-b").length,
      },
      /** `a` is the source and `b` the destination. */
      receivable,
      convergent: receivable.sourceOntoDestination || receivable.destinationOntoSource,
    },
  };
}
