import type {
  MachineCheckoutDescription,
  MachineHeadRelation,
  MachinePathStatus,
  MachineWorkingTreeMode,
  MachineWorkingTreeReason,
  MachineWorkingTreeReport,
  ProjectId,
} from "@t3tools/contracts";

import { type compareCheckouts, sameRepository } from "@t3tools/shared/machinesCheckout";
import type { PathPrefixMapping } from "./ClaudeTranscriptPortability.ts";

type CheckoutComparison = ReturnType<typeof compareCheckouts>;
type RepositoryKin = Pick<MachineCheckoutDescription, "remotes" | "rootCommits">;

const MAX_REPORTED_PATHS = 200;

// `b` is the destination: these are its changes that applying the source would overwrite.
const blockingPaths = (comparison: CheckoutComparison) =>
  comparison.paths.filter(
    (entry) =>
      entry.status === "differs" ||
      (entry.a === null && entry.b !== null && entry.b.kind !== "untracked"),
  );

export function planWorkingTree(input: {
  readonly mode: MachineWorkingTreeMode;
  readonly comparison: CheckoutComparison;
  readonly source: MachineCheckoutDescription;
  readonly destinationHead: string | null;
  readonly snapshotParent: string | null;
  readonly busy: boolean;
  readonly safetyRefExists: boolean;
}): {
  readonly action: "apply" | "applied" | "refs-only" | "skipped";
  readonly reason: MachineWorkingTreeReason;
} {
  if (input.mode === "none") return { action: "skipped", reason: "not-requested" };
  if (input.mode === "refs-only") return { action: "refs-only", reason: "requested" };
  if (input.source.entries.length === 0) return { action: "refs-only", reason: "nothing-to-apply" };
  if (input.destinationHead !== input.snapshotParent) {
    return { action: "refs-only", reason: "different-head" };
  }
  if (blockingPaths(input.comparison).length > 0) {
    return { action: "refs-only", reason: "destination-changes" };
  }
  if (input.busy) return { action: "refs-only", reason: "checkout-busy" };
  if (input.safetyRefExists) return { action: "applied", reason: "already-applied" };
  return { action: "apply", reason: "safe" };
}

const HEAD_RELATIONS = {
  same: "same",
  "a-ahead": "source-ahead",
  "b-ahead": "destination-ahead",
  diverged: "diverged",
  unknown: "unknown",
} as const satisfies Record<CheckoutComparison["head"], MachineHeadRelation>;

const PATH_STATUSES = {
  identical: "identical",
  "only-a": "only-source",
  "only-b": "only-destination",
  differs: "differs",
  unknown: "unknown",
} as const satisfies Record<CheckoutComparison["paths"][number]["status"], MachinePathStatus>;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function summarize(reason: MachineWorkingTreeReason, changed: number, blocking: number) {
  switch (reason) {
    case "not-requested":
      return "The working tree was not transferred.";
    case "requested":
      return "The source's working tree was imported as refs only, as requested.";
    case "nothing-to-apply":
      return "The source has no uncommitted changes, so only its refs were imported.";
    case "different-head":
      return "The destination is not on the commit the source's changes build on, so they were imported as refs only.";
    case "destination-changes":
      return `Applying would overwrite ${plural(blocking, "path")} changed on the destination, so the source's working tree was imported as refs only.`;
    case "checkout-busy":
      return "The destination checkout is in use, so the source's working tree was imported as refs only.";
    case "already-applied":
      return "The source's working tree was already applied here.";
    case "safe":
      return `Applied ${plural(changed, "changed path")} from the source onto the destination.`;
  }
}

export function workingTreeReportFields(input: {
  readonly comparison: CheckoutComparison;
  readonly source: MachineCheckoutDescription;
  readonly destination: MachineCheckoutDescription;
  readonly action: MachineWorkingTreeReport["action"];
  readonly reason: MachineWorkingTreeReason;
}): Omit<MachineWorkingTreeReport, "mergeBase" | "importedRefs" | "safetyRef"> {
  const { comparison } = input;
  const blocking = blockingPaths(comparison);
  const blockingSet = new Set(blocking);
  // Blocking paths first, then other differences, then paths both sides changed alike.
  const ordered = [
    ...blocking,
    ...comparison.paths.filter((entry) => !blockingSet.has(entry) && entry.status !== "identical"),
    ...comparison.paths.filter((entry) => entry.status === "identical"),
  ];
  const headRelation = HEAD_RELATIONS[comparison.head];
  const counts = comparison.summary.paths;
  return {
    action: input.action,
    reason: input.reason,
    source: {
      head: input.source.head,
      branch: input.source.branch,
      upstream: input.source.upstream,
    },
    destination: {
      head: input.destination.head,
      branch: input.destination.branch,
      upstream: input.destination.upstream,
    },
    headRelation,
    counts: {
      identical: counts.identical,
      onlySource: counts["only-a"],
      onlyDestination: counts["only-b"],
      differs: counts.differs,
      unknown: counts.unknown,
    },
    stashes: {
      both: comparison.summary.stashes.both,
      onlySource: comparison.summary.stashes.onlyA,
      onlyDestination: comparison.summary.stashes.onlyB,
    },
    blocking: blocking.map((entry) => entry.path),
    paths: ordered.slice(0, MAX_REPORTED_PATHS).map((entry) => ({
      path: entry.path,
      status: PATH_STATUSES[entry.status],
      sourceKind: entry.a?.kind ?? null,
      destinationKind: entry.b?.kind ?? null,
    })),
    truncated: ordered.length > MAX_REPORTED_PATHS,
    summary: summarize(input.reason, input.source.entries.length, blocking.length),
  };
}

const normalize = (value: string) => value.replace(/\/+$/, "") || "/";

const parentOf = (value: string) => {
  const index = value.lastIndexOf("/");
  return index <= 0 ? "/" : value.slice(0, index);
};

const segmentsOf = (value: string) => value.split("/").filter((segment) => segment.length > 0);

const isWithin = (candidate: string, root: string) =>
  candidate === root || candidate.startsWith(root === "/" ? "/" : `${root}/`);

const rewritePath = (value: string, mappings: ReadonlyArray<PathPrefixMapping>) => {
  const mapping = mappings
    .filter((entry) => isWithin(value, entry.from))
    .reduce<PathPrefixMapping | null>(
      (longest, entry) =>
        longest === null || entry.from.length > longest.from.length ? entry : longest,
      null,
    );
  return mapping === null ? value : mapping.to + value.slice(mapping.from.length);
};

export function transcriptMappings(input: {
  /** The source roots the sessions touched: checkout, project and worktree roots. */
  readonly sourceRoots: ReadonlyArray<string>;
  readonly sourceCheckoutRoot: string;
  readonly destinationRoot: string;
  readonly sourceHome: string;
  readonly destinationHome: string;
  readonly sourceClaudeConfigDir: string;
  readonly destinationClaudeConfigDir: string;
}): ReadonlyArray<PathPrefixMapping> {
  const destinationRoot = normalize(input.destinationRoot);
  const sourceHome = normalize(input.sourceHome);
  const destinationHome = normalize(input.destinationHome);
  const boundaries = new Set(["/", parentOf(sourceHome), parentOf(destinationHome)]);
  const mappings: Array<PathPrefixMapping> = input.sourceRoots
    .map(normalize)
    .toSorted((left, right) => right.length - left.length)
    .map((from) => ({ from, to: destinationRoot }));

  const sourceSegments = segmentsOf(normalize(input.sourceCheckoutRoot));
  const destinationSegments = segmentsOf(destinationRoot);
  let shared = 0;
  while (
    shared < Math.min(sourceSegments.length, destinationSegments.length) &&
    sourceSegments[sourceSegments.length - 1 - shared]!.toLowerCase() ===
      destinationSegments[destinationSegments.length - 1 - shared]!.toLowerCase()
  ) {
    shared++;
  }
  for (let level = 1; level < shared; level++) {
    const from = `/${sourceSegments.slice(0, -level).join("/")}`;
    const to = `/${destinationSegments.slice(0, -level).join("/")}`;
    if (boundaries.has(from) || boundaries.has(to)) break;
    mappings.push({ from, to });
  }

  mappings.push({ from: sourceHome, to: destinationHome });
  const sourceConfigDir = normalize(input.sourceClaudeConfigDir);
  const destinationConfigDir = normalize(input.destinationClaudeConfigDir);
  if (rewritePath(sourceConfigDir, mappings) !== destinationConfigDir) {
    mappings.push({ from: sourceConfigDir, to: destinationConfigDir });
  }

  const seen = new Set<string>();
  return mappings
    .filter((mapping) => {
      if (seen.has(mapping.from)) return false;
      seen.add(mapping.from);
      return mapping.from !== mapping.to;
    })
    .toSorted((left, right) => right.from.length - left.from.length);
}

const basename = (value: string) => segmentsOf(value).at(-1)?.toLowerCase() ?? "";

export function pickDestinationProject(input: {
  readonly source: { readonly root: string; readonly identity: RepositoryKin | null };
  readonly projects: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly root: string;
    readonly identity: RepositoryKin | null;
  }>;
  readonly requestedProjectId?: ProjectId;
  /** Without the working tree, any requested project may receive the sessions. */
  readonly workingTree: boolean;
}):
  | { readonly kind: "match"; readonly projectId: ProjectId }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<ProjectId> }
  | {
      readonly kind: "rejected";
      readonly projectId: ProjectId;
      readonly reason: "not-found" | "different-repository";
    } {
  const sourceIdentity = input.source.identity;
  const related = (identity: RepositoryKin | null) =>
    sourceIdentity !== null && identity !== null && sameRepository(sourceIdentity, identity);

  if (input.requestedProjectId !== undefined) {
    const projectId = input.requestedProjectId;
    const requested = input.projects.find((project) => project.projectId === projectId);
    if (requested === undefined) return { kind: "rejected", projectId, reason: "not-found" };
    return !input.workingTree || related(requested.identity)
      ? { kind: "match", projectId }
      : { kind: "rejected", projectId, reason: "different-repository" };
  }

  const candidates = input.projects.filter((project) => related(project.identity));
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "match", projectId: candidates[0]!.projectId };
  const sourceName = basename(input.source.root);
  const named = candidates.filter((project) => basename(project.root) === sourceName);
  return named.length === 1
    ? { kind: "match", projectId: named[0]!.projectId }
    : { kind: "ambiguous", candidates: candidates.map((project) => project.projectId) };
}
