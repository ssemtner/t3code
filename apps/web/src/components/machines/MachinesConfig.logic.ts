import {
  MachineConfigCategory,
  type EnvironmentId,
  type MachineConfigInventory,
  type MachineConfigItem,
} from "@t3tools/contracts";
import type {
  MachineConfigCategoryDiff,
  MachineConfigDiffEntry,
  MachineConfigDiffStatus,
} from "@t3tools/shared/machinesInventoryDiff";

export const CONFIG_CATEGORY_LABELS: Record<MachineConfigCategory, string> = {
  "mcp-server": "MCP servers",
  instructions: "Instructions",
  rule: "Rules",
  agent: "Agents",
  command: "Commands",
  skill: "Skills",
  hook: "Hooks",
  permission: "Permissions",
  env: "Env vars",
  plugin: "Plugins",
  marketplace: "Marketplaces",
  memory: "Memory",
  "output-style": "Output styles",
};

export type ConfigAvailability = "not-connected" | "stock" | "no-permission" | "query";

export function configAvailability(machine: {
  readonly connected: boolean;
  readonly machineTransfers: boolean | null;
  readonly canRead: boolean;
}): ConfigAvailability {
  if (!machine.connected) return "not-connected";
  if (machine.machineTransfers !== true) return "stock";
  return machine.canRead ? "query" : "no-permission";
}

export interface ConfigCategoryCount {
  readonly category: MachineConfigCategory;
  readonly label: string;
  readonly count: number;
}

export interface ConfigSummary {
  readonly counts: ReadonlyArray<ConfigCategoryCount>;
  readonly claudeVersion: string | null;
  readonly problems: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

export function summarizeInventory(
  inventory: Pick<MachineConfigInventory, "items" | "claudeVersion" | "problems">,
): ConfigSummary {
  const totals = new Map<MachineConfigCategory, number>();
  for (const item of inventory.items) {
    totals.set(item.category, (totals.get(item.category) ?? 0) + 1);
  }
  return {
    counts: MachineConfigCategory.literals.flatMap((category) => {
      const count = totals.get(category) ?? 0;
      return count === 0 ? [] : [{ category, label: CONFIG_CATEGORY_LABELS[category], count }];
    }),
    claudeVersion: inventory.claudeVersion,
    problems: inventory.problems.map((problem) => ({
      path: problem.path,
      reason: problem.reason,
    })),
  };
}

function defaultComparePair(
  loaded: ReadonlyArray<EnvironmentId>,
): readonly [EnvironmentId, EnvironmentId] | null {
  const [first, second] = loaded;
  return first === undefined || second === undefined ? null : [first, second];
}

/** Keep a user's pick only while it is still loaded and distinct; otherwise fall back. */
export function resolveComparePair(
  loaded: ReadonlyArray<EnvironmentId>,
  picked: { readonly a: EnvironmentId | null; readonly b: EnvironmentId | null },
): { readonly a: EnvironmentId; readonly b: EnvironmentId } | null {
  const fallback = defaultComparePair(loaded);
  if (fallback === null) return null;
  const a = picked.a !== null && loaded.includes(picked.a) ? picked.a : null;
  const b = picked.b !== null && loaded.includes(picked.b) ? picked.b : null;
  if (a !== null && b !== null && a !== b) return { a, b };
  if (a !== null) return { a, b: loaded.find((id) => id !== a) ?? fallback[1] };
  if (b !== null) return { a: loaded.find((id) => id !== b) ?? fallback[0], b };
  return { a: fallback[0], b: fallback[1] };
}

const basename = (value: string) => value.split(/[\\/]/).findLast((part) => part !== "") ?? value;

/** Names and shapes only; the inventory carries no values, and this adds none. */
export function configItemDetail(item: MachineConfigItem): string {
  const parts: Array<string> = [];
  switch (item.category) {
    case "mcp-server":
      parts.push(item.transport);
      if (item.command !== null) parts.push(basename(item.command));
      break;
    case "hook":
      parts.push(item.event);
      if (item.matcher !== null) parts.push(item.matcher);
      break;
    case "permission":
      parts.push(item.behavior);
      break;
    case "plugin":
      parts.push(item.enabled ? "enabled" : "disabled");
      if (item.version !== null) parts.push(item.version);
      break;
    case "skill":
      if (item.plugin !== null) parts.push(`plugin ${item.plugin}`);
      if (!item.enabled) parts.push("disabled");
      break;
    case "marketplace":
      parts.push(item.sourceType);
      break;
    default:
      break;
  }
  return parts.join(" · ");
}

export interface ConfigDisplayEntry {
  readonly id: string;
  readonly name: string;
  readonly meta: string;
}

function configDisplayEntry(entry: MachineConfigDiffEntry): ConfigDisplayEntry {
  const item = entry.a ?? entry.b;
  if (item === null) return { id: entry.id, name: entry.id, meta: "" };
  const meta = [
    item.scope,
    item.project,
    entry.status === "differs" || item.category === "hook" ? configItemDetail(item) : null,
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
  return { id: entry.id, name: item.name, meta };
}

export interface ConfigDiffGroup {
  readonly status: MachineConfigDiffStatus;
  readonly title: string;
  readonly entries: ReadonlyArray<ConfigDisplayEntry>;
  readonly collapsed: boolean;
}

// Longer groups start collapsed; a plugin's skills can run to hundreds of rows.
const OPEN_GROUP_LIMIT = 12;

export function groupDiffEntries(
  diff: MachineConfigCategoryDiff,
  labels: { readonly a: string; readonly b: string },
): ReadonlyArray<ConfigDiffGroup> {
  const order: ReadonlyArray<readonly [MachineConfigDiffStatus, string]> = [
    ["differs", "Differs"],
    ["only-a", `Only on ${labels.a}`],
    ["only-b", `Only on ${labels.b}`],
    ["same", "Same"],
  ];
  return order.flatMap(([status, title]) => {
    const entries = diff.entries.filter((entry) => entry.status === status);
    return entries.length === 0
      ? []
      : [
          {
            status,
            title,
            entries: entries.map(configDisplayEntry),
            collapsed: status === "same" || entries.length > OPEN_GROUP_LIMIT,
          },
        ];
  });
}
