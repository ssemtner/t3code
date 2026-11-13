import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { APP_VERSION } from "~/branding";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { environmentAtomList, environmentIdsKey } from "~/state/environmentAtomList";
import { environmentUpdateStatesAtom } from "~/state/server";
import { environmentSessionStatesAtom } from "~/state/session";
import { environmentThreadShells } from "~/state/threads";
import {
  getDesktopUpdateDownloadedVersion,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";
import { canUpdateServer } from "../ServerUpdateAction";
import { isHostedByThisApp } from "../sidebar/useUpdateEverything";
import { planMachineUpdates } from "./machineUpdates.logic";
import type { MachineState } from "./useMachines";

const runningThreadCountsAtom = environmentAtomList(
  "web-machines-running-threads",
  (environmentId) =>
    Atom.make(
      (get) =>
        get(environmentThreadShells.environmentThreadsAtom(environmentId)).filter(
          (thread) =>
            thread.status === "preparing" ||
            thread.status === "starting" ||
            thread.status === "running",
        ).length,
    ),
);
const NO_RUNNING_THREADS_ATOM = Atom.make<ReadonlyArray<number>>([]);

/** The release the sidebar's update pill moves servers to: this desktop app's pending update, else
 * this client's own version. */
function useMachineUpdateTargetVersion(): string {
  const state = useDesktopUpdateState();
  return state !== null && resolveDesktopUpdateButtonAction(state) !== "none"
    ? (getDesktopUpdateDownloadedVersion(state) ?? APP_VERSION)
    : APP_VERSION;
}

/** What updating each machine would do. Thread counts are read only when `withThreads`, since
 * they change on every turn and the machine list does not need them. */
export function useMachineUpdatePlan(
  machines: ReadonlyArray<MachineState>,
  { withThreads = false }: { readonly withThreads?: boolean } = {},
) {
  const targetVersion = useMachineUpdateTargetVersion();
  const key = environmentIdsKey(machines.map(({ environmentId }) => environmentId));
  const sessionStates = useAtomValue(environmentSessionStatesAtom(key));
  const updateStates = useAtomValue(environmentUpdateStatesAtom(key));
  const runningThreads = useAtomValue(
    withThreads ? runningThreadCountsAtom(key) : NO_RUNNING_THREADS_ATOM,
  );
  const rows = planMachineUpdates(
    machines.map((machine, index) => ({
      environmentId: machine.environmentId,
      label: machine.label,
      serverConfig: machine.environment.serverConfig,
      connected: machine.connected,
      hostedByThisApp: isHostedByThisApp(machine.environment),
      canMaintain: canUpdateServer(sessionStates[index]!),
      updateState: updateStates[index]!,
      isThisComputer: machine.isThisComputer,
      runningThreads: runningThreads[index] ?? 0,
    })),
    targetVersion,
  );
  return {
    targetVersion,
    rows,
    updateStates: new Map(
      machines.map((machine, index) => [machine.environmentId, updateStates[index]!]),
    ),
  };
}
