import type { RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupsByHistory, projectsWithRepository } from "./repositoryHistoryGroup.ts";

const identity = (canonicalKey: string, groupingKey?: string): RepositoryIdentity => ({
  canonicalKey,
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: `git@${canonicalKey}.git` },
  ...(groupingKey ? { origin: { canonicalKey: groupingKey } } : {}),
});

describe("groupsByHistory", () => {
  it.each([
    ["", true],
    ["t3code.groupbyhistory true", true],
    ["t3code.groupbyhistory", true],
    ["t3code.groupbyhistory false", false],
    ["t3code.groupbyhistory off", false],
    ["t3code.groupbyhistory 0", false],
    ["t3code.groupbyhistory no", false],
    ["t3code.groupbyhistory false\nt3code.groupbyhistory true", true],
    ["t3code.groupbyhistory true\nt3code.groupbyhistory FALSE", false],
  ])("parses %j as %s", (lines, expected) => {
    expect(groupsByHistory(lines)).toBe(expected);
  });
});

describe("projectsWithRepository", () => {
  const team = identity("github.com/theholycows/app", "git-root:abc");
  const personal = {
    id: "personal",
    repositoryIdentity: identity("github.com/ssemtner/app", "git-root:abc"),
  };
  const other = {
    id: "other",
    repositoryIdentity: identity("github.com/acme/other", "git-root:def"),
  };
  const none = { id: "none", repositoryIdentity: null };

  it("matches another machine's clone of the same history fetched through another remote", () => {
    expect(projectsWithRepository([none, other, personal], team)).toEqual([personal]);
  });

  it("prefers a clone of the same remote over one that only shares history", () => {
    const sameRemote = { id: "same", repositoryIdentity: identity("github.com/theholycows/app") };
    expect(projectsWithRepository([personal, sameRemote], team)).toEqual([sameRemote]);
  });
});
