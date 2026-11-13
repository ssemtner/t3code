import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShell } from "~/state/entities";
import { environmentServerConfigsAtom } from "~/state/server";
import { readEnvironmentScope } from "~/state/session";
import { moveThreadMenuReason } from "./moveThread.logic";

/** The thread the move dialog is open for; the menu and the palette close before it opens. */
export const moveThreadDialogAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("machines:move-thread-dialog"),
);

export function openMoveThreadDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(moveThreadDialogAtom, threadRef);
}

/** Why "Move to machine…" is disabled for a thread right now, or null when it is not. */
export function readMoveToMachineReason(threadRef: ScopedThreadRef): string | null {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId);
  return moveThreadMenuReason({
    canOperate: readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
    machineTransfers:
      config === undefined ? null : config.environment.capabilities.machineTransfers === true,
    isRunning: !threadRuntimeCanArchive(readThreadShell(threadRef)?.runtime),
  });
}
