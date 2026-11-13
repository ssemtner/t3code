import {
  repositoryGroupingDisplayNameOf,
  repositoryGroupingKeyOf,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type * as ProcessRunner from "../processRunner.ts";

/**
 * Clones group by their first commit, so one repository fetched through different remotes shares a
 * sidebar group. On by default in this fork; `git config t3code.groupByHistory false` opts out.
 * Prompt links stop matching because they read the grouping key as `host/owner/name`.
 */
const HISTORY_GROUPING_CONFIG_KEY = "t3code.groupbyhistory";
export const HISTORY_GROUPING_CONFIG_PATTERN = HISTORY_GROUPING_CONFIG_KEY.replace(".", "\\.");

export function groupsByHistory(configLines: string): boolean {
  let enabled = true;
  // `--get-regexp` lists system, global, then local values; the last one wins, as in git.
  for (const line of configLines.split("\n")) {
    const [key, value = "true"] = line.trim().split(/\s+/u, 2);
    if (key !== HISTORY_GROUPING_CONFIG_KEY) continue;
    enabled = ["true", "yes", "on", "1"].includes(value.toLowerCase());
  }
  return enabled;
}

const ROOT_COMMIT_TIMEOUT: Duration.Input = "5 seconds";

/**
 * Carries the first commit of HEAD's first-parent chain as the grouping key, where clients
 * already read it. Merged-in histories add roots only on second parents. Shallow clones have no
 * reliable root, so they and any failure keep the remote-based identity.
 */
export const withHistoryGroup = Effect.fn("RepositoryIdentityResolver.withHistoryGroup")(function* (
  identity: RepositoryIdentity,
  runGit: (
    args: ReadonlyArray<string>,
    timeout?: Duration.Input,
  ) => Effect.Effect<Option.Option<ProcessRunner.ProcessRunOutput>>,
) {
  const displayName = repositoryGroupingDisplayNameOf(identity);
  if (displayName === undefined) return identity;
  const [shallow, root] = yield* Effect.all(
    [
      runGit(["rev-parse", "--is-shallow-repository"]),
      runGit(
        ["--no-replace-objects", "rev-list", "--first-parent", "--max-parents=0", "HEAD"],
        ROOT_COMMIT_TIMEOUT,
      ),
    ],
    { concurrency: "unbounded" },
  );
  if (shallow._tag === "None" || shallow.value.stdout.trim() !== "false") return identity;
  if (root._tag === "None" || root.value.code !== 0 || root.value.timedOut) return identity;
  const rootCommit = root.value.stdout.trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(rootCommit)) return identity;
  const remoteUrl = identity.origin?.remoteUrl;
  return {
    ...identity,
    origin: {
      canonicalKey: `git-root:${rootCommit}`,
      displayName,
      ...(remoteUrl ? { remoteUrl } : {}),
    },
  };
});

/**
 * Another environment's projects with this repository: the same remote first, else the same
 * grouping key, which matches clones fetched through different remotes when both group by history.
 */
export function projectsWithRepository<
  P extends { readonly repositoryIdentity?: RepositoryIdentity | null | undefined },
>(projects: ReadonlyArray<P>, identity: RepositoryIdentity): P[] {
  const sameRemote = projects.filter(
    (project) => project.repositoryIdentity?.canonicalKey === identity.canonicalKey,
  );
  if (sameRemote.length > 0) return sameRemote;
  const groupingKey = repositoryGroupingKeyOf(identity);
  return projects.filter(
    (project) =>
      project.repositoryIdentity != null &&
      repositoryGroupingKeyOf(project.repositoryIdentity) === groupingKey,
  );
}
