import { EnvironmentId, type MachineConfigItem } from "@t3tools/contracts";
import { diffInventories } from "@t3tools/shared/machinesInventoryDiff";
import { describe, expect, it } from "vite-plus/test";

import {
  configAvailability,
  configItemDetail,
  groupDiffEntries,
  resolveComparePair,
  summarizeInventory,
} from "./MachinesConfig.logic";

const base = { scope: "user", path: "/x", project: null, sizeBytes: 1, modifiedAt: null } as const;
const rule = (name: string, sha256 = "1"): MachineConfigItem => ({
  ...base,
  id: `rule:user:${name}`,
  name,
  sha256,
  category: "rule",
});
const mcp = (name: string): MachineConfigItem => ({
  ...base,
  id: `mcp-server:user:${name}`,
  name,
  sha256: "m",
  category: "mcp-server",
  mcpScope: "user",
  transport: "stdio",
  command: "/usr/bin/npx",
});
const hook: MachineConfigItem = {
  ...base,
  id: "hook:user:1",
  name: "PreToolUse",
  sha256: "h",
  category: "hook",
  event: "PreToolUse",
  matcher: "Bash",
  handlerTypes: ["command"],
  commands: ["secret.sh"],
};
const a = EnvironmentId.make("a");
const b = EnvironmentId.make("b");
const c = EnvironmentId.make("c");

describe("configAvailability", () => {
  it("orders the reasons a machine cannot be read", () => {
    const ok = { connected: true, machineTransfers: true, canRead: true };
    expect(configAvailability(ok)).toBe("query");
    expect(configAvailability({ ...ok, connected: false, machineTransfers: null })).toBe(
      "not-connected",
    );
    expect(configAvailability({ ...ok, machineTransfers: false })).toBe("stock");
    expect(configAvailability({ ...ok, canRead: false })).toBe("no-permission");
  });
});

describe("summarizeInventory", () => {
  it("counts non-empty categories in category order with problems", () => {
    const summary = summarizeInventory({
      items: [rule("a"), mcp("x"), rule("b")],
      claudeVersion: "2.1.0",
      problems: [{ path: "/p", reason: "malformed" }],
    });
    expect(summary.counts.map((entry) => [entry.label, entry.count])).toEqual([
      ["MCP servers", 1],
      ["Rules", 2],
    ]);
    expect(summary.claudeVersion).toBe("2.1.0");
    expect(summary.problems).toEqual([{ path: "/p", reason: "malformed" }]);
  });
});

describe("resolveComparePair", () => {
  it("defaults to the first two and keeps valid picks", () => {
    expect(resolveComparePair([a], { a: null, b: null })).toBeNull();
    expect(resolveComparePair([a, b, c], { a: null, b: null })).toEqual({ a, b });
    expect(resolveComparePair([a, b, c], { a: c, b: null })).toEqual({ a: c, b: a });
    expect(resolveComparePair([a, b, c], { a: b, b: b })).toEqual({ a: b, b: a });
    expect(resolveComparePair([a, b], { a: c, b: a })).toEqual({ a: b, b: a });
  });
});

describe("configItemDetail", () => {
  it("shows names only, never command arguments or handlers", () => {
    expect(configItemDetail(mcp("x"))).toBe("stdio · npx");
    expect(configItemDetail(hook)).toBe("PreToolUse · Bash");
  });
});

describe("groupDiffEntries", () => {
  it("groups by status with labels, same collapsed", () => {
    const diff = diffInventories(
      { items: [rule("same"), rule("diff", "1"), rule("left")] },
      { items: [rule("same"), rule("diff", "2"), rule("right")] },
    );
    const groups = groupDiffEntries(diff.categories[0]!, { a: "Laptop", b: "Desk" });
    expect(
      groups.map((group) => [group.title, group.entries.map((e) => e.name), group.collapsed]),
    ).toEqual([
      ["Differs", ["diff"], false],
      ["Only on Laptop", ["left"], false],
      ["Only on Desk", ["right"], false],
      ["Same", ["same"], true],
    ]);
    expect(groups[0]!.entries[0]!.meta).toBe("user");
  });
});
