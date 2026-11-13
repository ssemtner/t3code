import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@t3tools/contracts";
import { diffInventories } from "@t3tools/shared/machinesInventoryDiff";
import { useState } from "react";

import { environmentAtomList, environmentIdsKey } from "~/state/environmentAtomList";
import { machineEnvironment } from "~/state/machines";
import { formatEnvironmentQueryError } from "~/state/query";
import { useEnvironmentsWithScope } from "~/state/session";
import { SettingsSection } from "../settings/settingsLayout";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  type ConfigDiffGroup,
  type ConfigSummary,
  configAvailability,
  groupDiffEntries,
  resolveComparePair,
  summarizeInventory,
  CONFIG_CATEGORY_LABELS,
} from "./MachinesConfig.logic";
import type { MachineState } from "./useMachines";

const inventoryListsAtom = environmentAtomList("web-machines-config-inventory", (environmentId) =>
  machineEnvironment.inventory({ environmentId, input: {} }),
);

type InventoryState =
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly summary: ConfigSummary;
      readonly inventory: Parameters<typeof diffInventories>[0];
    };

const NOTES = {
  "not-connected": "Not connected.",
  stock: "This machine runs a server without config transfers.",
  "no-permission": "No permission to read this machine's config.",
} as const;

export function MachinesConfigSection({
  machines,
}: {
  readonly machines: ReadonlyArray<MachineState>;
}) {
  const advertising = machines.filter((machine) => machine.facts.machineTransfers === true);
  const readable = useEnvironmentsWithScope(advertising, AuthOrchestrationReadScope);
  const availability = new Map(
    machines.map((machine) => [
      machine.environmentId,
      configAvailability({
        connected: machine.connected,
        machineTransfers: machine.facts.machineTransfers,
        canRead: readable.has(machine.environmentId),
      }),
    ]),
  );
  const queryIds = machines.flatMap((machine) =>
    availability.get(machine.environmentId) === "query" ? [machine.environmentId] : [],
  );
  const results = useAtomValue(inventoryListsAtom(environmentIdsKey(queryIds)));
  const [picked, setPicked] = useState<{
    readonly a: EnvironmentId | null;
    readonly b: EnvironmentId | null;
  }>({ a: null, b: null });

  if (advertising.length === 0) return null;

  const states = new Map<EnvironmentId, InventoryState>(
    machines.map((machine) => {
      const kind = availability.get(machine.environmentId)!;
      if (kind !== "query") {
        return [machine.environmentId, { kind: "note", text: NOTES[kind] }];
      }
      const result = results[queryIds.indexOf(machine.environmentId)]!;
      const state: InventoryState =
        result._tag === "Success"
          ? {
              kind: "ready",
              summary: summarizeInventory(result.value),
              inventory: result.value,
            }
          : result._tag === "Failure"
            ? { kind: "failed", message: formatEnvironmentQueryError(result.cause) }
            : { kind: "loading" };
      return [machine.environmentId, state];
    }),
  );
  const loadedIds = machines.flatMap((machine) =>
    states.get(machine.environmentId)?.kind === "ready" ? [machine.environmentId] : [],
  );
  const pair = resolveComparePair(loadedIds, picked);
  const labelOf = (id: EnvironmentId) =>
    machines.find((machine) => machine.environmentId === id)?.label ?? id;
  const inventoryOf = (id: EnvironmentId) => {
    const state = states.get(id);
    return state?.kind === "ready" ? state.inventory : null;
  };
  const inventoryA = pair === null ? null : inventoryOf(pair.a);
  const inventoryB = pair === null ? null : inventoryOf(pair.b);
  const diff =
    inventoryA !== null && inventoryB !== null ? diffInventories(inventoryA, inventoryB) : null;

  return (
    <SettingsSection title="Claude Code config">
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Read-only. To copy config between machines, ask the Assistant (button at the top of this
        page).
      </p>
      <ul
        aria-label="Machine config"
        className="divide-y divide-border/50 border-t border-border/50"
      >
        {machines.map((machine) => (
          <MachineSummaryRow
            key={machine.environmentId}
            label={machine.label}
            state={states.get(machine.environmentId)!}
          />
        ))}
      </ul>
      {pair !== null && diff !== null ? (
        <div className="border-t border-border/50 px-3 py-3 sm:px-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <MachinePicker
              label="Machine A"
              value={pair.a}
              ids={loadedIds}
              labelOf={labelOf}
              onChange={(a) => setPicked({ a, b: pair.b })}
            />
            <MachinePicker
              label="Machine B"
              value={pair.b}
              ids={loadedIds}
              labelOf={labelOf}
              onChange={(b) => setPicked({ a: pair.a, b })}
            />
          </div>
          {diff.categories.length === 0 ? (
            <p className="pt-3 text-sm text-muted-foreground">Neither machine has any config.</p>
          ) : (
            <div className="space-y-4 pt-3">
              {diff.categories.map((category) => (
                <CategoryDiff
                  key={category.category}
                  title={CONFIG_CATEGORY_LABELS[category.category]}
                  summary={`${category.counts.same} same, ${category.counts.differs} differ, ${category.counts["only-a"]} only on ${labelOf(pair.a)}, ${category.counts["only-b"]} only on ${labelOf(pair.b)}`}
                  groups={groupDiffEntries(category, { a: labelOf(pair.a), b: labelOf(pair.b) })}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="border-t border-border/50 px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          Two machines with a loaded config are needed to compare.
        </p>
      )}
    </SettingsSection>
  );
}

function MachineSummaryRow({
  label,
  state,
}: {
  readonly label: string;
  readonly state: InventoryState;
}) {
  return (
    <li className="px-3 py-2.5 sm:px-4">
      <p className="text-sm font-medium text-foreground">
        {label}
        {state.kind === "ready" && state.summary.claudeVersion !== null ? (
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            Claude {state.summary.claudeVersion}
          </span>
        ) : null}
      </p>
      {state.kind === "note" ? (
        <p className="text-xs text-muted-foreground">{state.text}</p>
      ) : state.kind === "loading" ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : state.kind === "failed" ? (
        <p className="text-xs text-destructive">Could not read config: {state.message}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {state.summary.counts.length === 0
              ? "No config found."
              : state.summary.counts.map((entry) => `${entry.label} ${entry.count}`).join(" · ")}
          </p>
          {state.summary.problems.map((problem) => (
            <p key={problem.path} className="break-all text-xs text-warning">
              {problem.path}: {problem.reason}
            </p>
          ))}
        </>
      )}
    </li>
  );
}

function MachinePicker({
  label,
  value,
  ids,
  labelOf,
  onChange,
}: {
  readonly label: string;
  readonly value: EnvironmentId;
  readonly ids: ReadonlyArray<EnvironmentId>;
  readonly labelOf: (id: EnvironmentId) => string;
  readonly onChange: (id: EnvironmentId) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const id = ids.find((candidate) => candidate === next);
        if (id !== undefined) onChange(id);
      }}
    >
      <SelectTrigger size="sm" className="w-full min-w-0" aria-label={label}>
        <SelectValue>{labelOf(value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {ids.map((id) => (
          <SelectItem key={id} value={id}>
            {labelOf(id)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function CategoryDiff({
  title,
  summary,
  groups,
}: {
  readonly title: string;
  readonly summary: string;
  readonly groups: ReadonlyArray<ConfigDiffGroup>;
}) {
  return (
    <section>
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <p className="text-xs text-muted-foreground">{summary}</p>
      <div className="space-y-2 pt-1.5">
        {groups.map((group) => (
          <EntryGroup key={group.status} group={group} />
        ))}
      </div>
    </section>
  );
}

function EntryGroup({ group }: { readonly group: ConfigDiffGroup }) {
  const [open, setOpen] = useState(!group.collapsed);
  return (
    <div>
      <button
        type="button"
        className="text-xs font-medium text-muted-foreground"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {group.title} ({group.entries.length}) {open ? "−" : "+"}
      </button>
      {open ? (
        <ul className="pt-0.5">
          {group.entries.map((entry) => (
            <li key={entry.id} className="py-0.5 text-sm break-words text-foreground">
              {entry.name}
              {entry.meta === "" ? null : (
                <span className="ml-2 text-xs text-muted-foreground">{entry.meta}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
