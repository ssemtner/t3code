import type { MachineConfigItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { diffInventories, homeRelativePath, machineProjectKey } from "./machinesInventoryDiff.ts";

const rule = (file: string, sha256: string, home: string): MachineConfigItem => ({
  id: `rule:user:${file}`,
  category: "rule",
  scope: "user",
  name: file,
  path: `${home}/.claude/rules/${file}`,
  project: null,
  sizeBytes: 1,
  sha256,
  modifiedAt: home === "/Users/ssemtner" ? "2026-01-01T00:00:00.000Z" : "2026-06-01T00:00:00.000Z",
});

const env = (id: string, sha256: string): MachineConfigItem => ({
  id,
  category: "env",
  scope: "user",
  name: id,
  path: "/settings.json",
  project: null,
  sizeBytes: 1,
  sha256,
  modifiedAt: null,
});

describe("diffInventories", () => {
  it("classifies by id and content hash, ignoring paths and mtimes, grouped in category order", () => {
    const mac = "/Users/ssemtner";
    const linux = "/home/sjsem";
    const diff = diffInventories(
      {
        items: [
          env("env:user:A", "1"),
          rule("same.md", "s", mac),
          rule("changed.md", "a", mac),
          rule("mac-only.md", "m", mac),
        ],
      },
      {
        items: [
          rule("linux-only.md", "l", linux),
          rule("changed.md", "b", linux),
          rule("same.md", "s", linux),
          env("env:user:A", "1"),
        ],
      },
    );

    expect(diff.counts).toEqual({ same: 2, differs: 1, "only-a": 1, "only-b": 1 });
    expect(diff.categories.map((group) => [group.category, group.counts])).toEqual([
      ["rule", { same: 1, differs: 1, "only-a": 1, "only-b": 1 }],
      ["env", { same: 1, differs: 0, "only-a": 0, "only-b": 0 }],
    ]);
    expect(
      diff.categories[0]?.entries.map((entry) => [
        entry.id,
        entry.status,
        entry.a?.path ?? null,
        entry.b?.path ?? null,
      ]),
    ).toEqual([
      [
        "rule:user:changed.md",
        "differs",
        `${mac}/.claude/rules/changed.md`,
        `${linux}/.claude/rules/changed.md`,
      ],
      ["rule:user:linux-only.md", "only-b", null, `${linux}/.claude/rules/linux-only.md`],
      ["rule:user:mac-only.md", "only-a", `${mac}/.claude/rules/mac-only.md`, null],
      [
        "rule:user:same.md",
        "same",
        `${mac}/.claude/rules/same.md`,
        `${linux}/.claude/rules/same.md`,
      ],
    ]);
  });
});

describe("homeRelativePath", () => {
  it.each([
    ["/Users/ssemtner/.claude/CLAUDE.md", "/Users/ssemtner", "~/.claude/CLAUDE.md"],
    ["/home/sjsem/.claude/CLAUDE.md", "/home/sjsem/", "~/.claude/CLAUDE.md"],
    ["/home/sjsem", "/home/sjsem", "~"],
    ["/home/sjsemantic/x", "/home/sjsem", "/home/sjsemantic/x"],
    ["/etc/claude-code/CLAUDE.md", "/home/sjsem", "/etc/claude-code/CLAUDE.md"],
  ])("%s under %s", (path, home, expected) => {
    expect(homeRelativePath(path, home)).toBe(expected);
  });
});

describe("machineProjectKey", () => {
  it.each([
    ["-Users-ssemtner-Developer-t3code", "-Users-ssemtner", "~/developer-t3code"],
    ["-home-sjsem-developer-t3code", "-home-sjsem", "~/developer-t3code"],
    ["-home-sjsem", "-home-sjsem", "~"],
    ["-opt-src-Repo", "-home-sjsem", "-opt-src-repo"],
  ])("%s", (projectDir, homeDir, expected) => {
    expect(machineProjectKey(projectDir, homeDir)).toBe(expected);
  });
});
