import {
  MachineConfigCategory,
  type MachineConfigInventory,
  type MachineConfigItem,
} from "@t3tools/contracts";

export type MachineConfigDiffStatus = "same" | "differs" | "only-a" | "only-b";

export interface MachineConfigDiffEntry {
  readonly id: string;
  readonly status: MachineConfigDiffStatus;
  readonly a: MachineConfigItem | null;
  readonly b: MachineConfigItem | null;
}

export type MachineConfigDiffCounts = Readonly<Record<MachineConfigDiffStatus, number>>;

export interface MachineConfigCategoryDiff {
  readonly category: MachineConfigCategory;
  readonly counts: MachineConfigDiffCounts;
  readonly entries: ReadonlyArray<MachineConfigDiffEntry>;
}

export interface MachineConfigInventoryDiff {
  readonly counts: MachineConfigDiffCounts;
  /** In `MachineConfigCategory` order, only categories with an item on either side. */
  readonly categories: ReadonlyArray<MachineConfigCategoryDiff>;
}

/** `~` or `~/rest` for a path under `homeDir`, so two machines' homes compare equal. */
export function homeRelativePath(path: string, homeDir: string): string {
  const home = homeDir.replace(/\/+$/, "");
  if (home === "") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/**
 * The machine-independent key of a project, from Claude's encoded project folder name (every
 * non-alphanumeric character as `-`) and the encoded home directory. Lowercased because the same
 * checkout is often `~/Developer/x` on one machine and `~/developer/x` on another.
 */
export function machineProjectKey(encodedProjectDir: string, encodedHomeDir: string): string {
  if (encodedProjectDir === encodedHomeDir) return "~";
  const relative = encodedProjectDir.startsWith(`${encodedHomeDir}-`)
    ? `~/${encodedProjectDir.slice(encodedHomeDir.length + 1)}`
    : encodedProjectDir;
  return relative.toLowerCase();
}

const emptyCounts = (): Record<MachineConfigDiffStatus, number> => ({
  same: 0,
  differs: 0,
  "only-a": 0,
  "only-b": 0,
});

/** Items match by id and compare by `sha256`; paths and mtimes are machine-specific and ignored. */
export function diffInventories(
  a: Pick<MachineConfigInventory, "items">,
  b: Pick<MachineConfigInventory, "items">,
): MachineConfigInventoryDiff {
  const byIdA = new Map(a.items.map((item) => [item.id, item]));
  const byIdB = new Map(b.items.map((item) => [item.id, item]));
  const byCategory = new Map<MachineConfigCategory, Array<MachineConfigDiffEntry>>();
  for (const id of new Set([...byIdA.keys(), ...byIdB.keys()])) {
    const itemA = byIdA.get(id) ?? null;
    const itemB = byIdB.get(id) ?? null;
    const category = (itemA ?? itemB)?.category;
    if (category === undefined) continue;
    const status: MachineConfigDiffStatus =
      itemA === null
        ? "only-b"
        : itemB === null
          ? "only-a"
          : itemA.sha256 === itemB.sha256
            ? "same"
            : "differs";
    const entries = byCategory.get(category) ?? [];
    entries.push({ id, status, a: itemA, b: itemB });
    byCategory.set(category, entries);
  }

  const counts = emptyCounts();
  const categories: Array<MachineConfigCategoryDiff> = [];
  for (const category of MachineConfigCategory.literals) {
    const entries = byCategory.get(category);
    if (entries === undefined) continue;
    const categoryCounts = emptyCounts();
    for (const entry of entries) {
      categoryCounts[entry.status] += 1;
      counts[entry.status] += 1;
    }
    categories.push({
      category,
      counts: categoryCounts,
      entries: [...entries].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      ),
    });
  }
  return { counts, categories };
}
