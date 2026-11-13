import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { cn } from "~/lib/utils";
import {
  type ServerUpdateTarget,
  serverUpdateStageLabel,
  useServerUpdate,
} from "../ServerUpdateAction";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  defaultMachineUpdateSelection,
  type MachineUpdateRow,
  type MachineUpdateRunState,
  runMachineUpdates,
  selectedMachineUpdates,
} from "./machineUpdates.logic";
import type { MachineState } from "./useMachines";
import { useMachineUpdatePlan } from "./useMachineUpdates";

type Run =
  | { readonly phase: "review" }
  | {
      readonly phase: "running" | "done";
      readonly targets: ReadonlyArray<ServerUpdateTarget>;
      readonly progress: ReadonlyMap<EnvironmentId, MachineUpdateRunState>;
    };

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Lists what updating each machine would do, then updates the ticked ones one at a time. */
export function UpdateMachinesDialog({
  machines,
  onClose,
}: {
  readonly machines: ReadonlyArray<MachineState>;
  readonly onClose: () => void;
}) {
  const { rows, updateStates } = useMachineUpdatePlan(machines, { withThreads: true });
  // Null until the user changes a box, so the default follows threads that start or stop meanwhile.
  const [picked, setPicked] = useState<ReadonlySet<EnvironmentId> | null>(null);
  const [run, setRun] = useState<Run>({ phase: "review" });
  // A double click can start two runs before a re-render; this guard is synchronous.
  const started = useRef(false);
  const updateServer = useServerUpdate();
  const selected = picked ?? defaultMachineUpdateSelection(rows);
  const targets = selectedMachineUpdates(rows, selected);

  const toggle = (environmentId: EnvironmentId, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(environmentId);
    else next.delete(environmentId);
    setPicked(next);
  };

  const start = async () => {
    if (started.current || targets.length === 0) return;
    started.current = true;
    setRun({ phase: "running", targets, progress: new Map() });
    await runMachineUpdates(
      targets,
      (target) => updateServer(target, { quiet: true }),
      (environmentId, state) =>
        setRun((current) =>
          current.phase === "review"
            ? current
            : { ...current, progress: new Map(current.progress).set(environmentId, state) },
        ),
    );
    setRun((current) => (current.phase === "running" ? { ...current, phase: "done" } : current));
  };

  const liveVersion = (environmentId: EnvironmentId) =>
    machines.find((machine) => machine.environmentId === environmentId)?.environment.serverConfig
      ?.environment.serverVersion ?? null;

  const runStatus = (environmentId: EnvironmentId, state: MachineUpdateRunState | undefined) => {
    if (state === undefined || state.status === "waiting") return "Waiting…";
    if (state.status === "failed") return state.message;
    if (state.status === "updated") {
      const version = liveVersion(environmentId);
      return version === null ? "Restarted" : `Restarted on v${version}`;
    }
    const updateState = updateStates.get(environmentId);
    return updateState?.status === "running"
      ? serverUpdateStageLabel(updateState.stage)
      : "Updating…";
  };

  const running = run.phase === "running";
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !running) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Update machines</DialogTitle>
          <DialogDescription>
            Updating restarts a machine's server, which stops agent turns running there. Machines
            update one at a time, this computer last.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {run.phase === "review" ? (
            <ul className="space-y-2">
              {rows.map((row) => {
                const selectable = row.kind === "update" || row.kind === "busy";
                return (
                  <li key={row.environmentId} className="flex items-start gap-2.5 text-sm">
                    <Checkbox
                      checked={selectable && selected.has(row.environmentId)}
                      disabled={!selectable}
                      onCheckedChange={(checked) => toggle(row.environmentId, checked === true)}
                      aria-label={`Update ${row.label}`}
                    />
                    <div className={cn("min-w-0 flex-1", !selectable && "text-muted-foreground")}>
                      <div className="flex items-center gap-1.5">
                        <span className="min-w-0 truncate font-medium">{row.label}</span>
                        {row.isThisComputer ? (
                          <Badge variant="secondary">This computer</Badge>
                        ) : null}
                      </div>
                      <span
                        className={cn(
                          "block text-xs text-muted-foreground",
                          row.kind === "busy" && "text-warning-foreground",
                        )}
                      >
                        {planDetail(row)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <ul className="space-y-1.5" aria-live="polite">
              {run.targets.map((target) => {
                const state = run.progress.get(target.environmentId);
                return (
                  <li key={target.environmentId} className="text-sm">
                    <span className="font-medium text-foreground">{target.serverLabel}</span>
                    <span
                      className={cn(
                        "block text-xs text-muted-foreground",
                        state?.status === "failed" && "text-destructive",
                      )}
                    >
                      {runStatus(target.environmentId, state)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          {run.phase === "review" ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={targets.length === 0} onClick={() => void start()}>
                {targets.length === 0
                  ? "Nothing selected"
                  : `Update ${plural(targets.length, "machine")}`}
              </Button>
            </>
          ) : (
            <Button variant="outline" disabled={running} onClick={onClose}>
              {running ? "Updating…" : "Close"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function planDetail(row: MachineUpdateRow): string {
  const from = row.fromVersion === null ? "unknown version" : `v${row.fromVersion}`;
  switch (row.kind) {
    case "current":
      return `${from} · up to date`;
    case "unavailable":
      return `Cannot update here: ${row.reason}`;
    case "update":
    case "busy": {
      const parts = [`${from} → v${row.target.targetVersion}`];
      if (row.target.selfUpdate === "desktop-managed") parts.push("relaunches its desktop app");
      if (row.kind === "busy") {
        parts.push(
          `${plural(row.runningThreads, "thread")} running${row.continuesThreads ? ", continued after the restart" : ", stopped by the restart"}`,
        );
      }
      return parts.join(" · ");
    }
  }
}
