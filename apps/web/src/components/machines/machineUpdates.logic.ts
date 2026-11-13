import type { EnvironmentId } from "@t3tools/contracts";

import type { ServerUpdateOutcome, ServerUpdateTarget } from "../ServerUpdateAction";
import {
  collectServerUpdateTargets,
  type UpdateEverythingMachine,
} from "../sidebar/updateEverything.logic";

export interface MachineUpdateInput extends UpdateEverythingMachine {
  readonly isThisComputer: boolean;
  readonly runningThreads: number;
}

export type MachineUpdateRow = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isThisComputer: boolean;
  readonly fromVersion: string | null;
  readonly runningThreads: number;
  /** Whether running threads continue on their own after the restart. */
  readonly continuesThreads: boolean;
} & (
  | { readonly kind: "update" | "busy"; readonly target: ServerUpdateTarget }
  | { readonly kind: "current" }
  | { readonly kind: "unavailable"; readonly reason: string }
);

/** Every machine with what an update to `targetVersion` would do there; this computer goes last,
 * since updating it can drop this client's connection to the others. */
export function planMachineUpdates(
  machines: ReadonlyArray<MachineUpdateInput>,
  targetVersion: string,
): ReadonlyArray<MachineUpdateRow> {
  const connected = machines.filter((machine) => machine.connected);
  const { targets, skipped } = collectServerUpdateTargets(connected, targetVersion);
  const rows = machines.map((machine): MachineUpdateRow => {
    const base = {
      environmentId: machine.environmentId,
      label: machine.label,
      isThisComputer: machine.isThisComputer,
      fromVersion: machine.serverConfig?.environment.serverVersion ?? null,
      runningThreads: machine.runningThreads,
      continuesThreads: machine.serverConfig?.settings.continueThreadsAfterServerUpdate === true,
    };
    if (!machine.connected) return { ...base, kind: "unavailable", reason: "not connected" };
    const target = targets.find((entry) => entry.environmentId === machine.environmentId);
    if (target !== undefined) {
      return { ...base, kind: machine.runningThreads > 0 ? "busy" : "update", target };
    }
    const skip = skipped.find((entry) => entry.environmentId === machine.environmentId);
    if (skip !== undefined) return { ...base, kind: "unavailable", reason: skip.reason };
    if (machine.hostedByThisApp) {
      return { ...base, kind: "unavailable", reason: "updates with this desktop app" };
    }
    return { ...base, kind: "current" };
  });
  return [
    ...rows.filter((row) => !row.isThisComputer),
    ...rows.filter((row) => row.isThisComputer),
  ];
}

/** Busy machines stay unticked: their restart stops running agent turns. */
export function defaultMachineUpdateSelection(
  rows: ReadonlyArray<MachineUpdateRow>,
): ReadonlySet<EnvironmentId> {
  return new Set(rows.filter((row) => row.kind === "update").map((row) => row.environmentId));
}

/** The version a row's machine would move to, or null when it has no update from here. */
export function machineUpdateVersion(row: MachineUpdateRow | undefined): string | null {
  return row !== undefined && (row.kind === "update" || row.kind === "busy")
    ? row.target.targetVersion
    : null;
}

/** The ticked updatable rows, in plan order. */
export function selectedMachineUpdates(
  rows: ReadonlyArray<MachineUpdateRow>,
  selected: ReadonlySet<EnvironmentId>,
): ReadonlyArray<ServerUpdateTarget> {
  return rows.flatMap((row) =>
    (row.kind === "update" || row.kind === "busy") && selected.has(row.environmentId)
      ? [row.target]
      : [],
  );
}

/** One machine at a time, so each restart is visible on its own; a failure does not stop the rest. */
export async function runMachineUpdates(
  targets: ReadonlyArray<ServerUpdateTarget>,
  update: (target: ServerUpdateTarget) => Promise<ServerUpdateOutcome>,
  onProgress: (environmentId: EnvironmentId, state: MachineUpdateRunState) => void,
): Promise<void> {
  for (const target of targets) {
    onProgress(target.environmentId, { status: "updating" });
    const outcome = await update(target);
    onProgress(
      target.environmentId,
      outcome.status === "updated"
        ? { status: "updated" }
        : {
            status: "failed",
            message:
              outcome.status === "failed"
                ? outcome.message
                : "Not started: another update is running there, or this session may not update it.",
          },
    );
  }
}

export type MachineUpdateRunState =
  | { readonly status: "waiting" | "updating" | "updated" }
  | { readonly status: "failed"; readonly message: string };
