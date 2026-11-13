import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";

import { useNowMinute } from "~/hooks/useNowMinute";
import { refreshArchivedThreadsForEnvironment } from "~/lib/archivedThreadsState";
import { machineEnvironment } from "~/state/machines";
import { useEnvironmentsWithScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { transferFailureMessage } from "./MachinesRepos.logic";
import {
  type MoveDestination,
  moveDestinations,
  type MoveSteps,
  type Step,
} from "./moveThread.logic";
import { useMachines } from "./useMachines";
import { useMachineTransfer } from "./useMachineTransfer";

function toStep<A, E>(result: AtomCommandResult<A, E>): Step<A> {
  if (result._tag === "Success") return { ok: true, value: result.value };
  return {
    ok: false,
    message: isAtomCommandInterrupted(result)
      ? "Stopped."
      : transferFailureMessage(squashAtomCommandFailure(result)),
  };
}

/** Every other machine, with why a thread on `source` cannot move there. */
export function useMoveDestinations(sourceEnvironmentId: EnvironmentId): {
  readonly sourceLabel: string;
  readonly destinations: ReadonlyArray<MoveDestination>;
} {
  const { machines } = useMachines();
  const operable = useEnvironmentsWithScope(machines, AuthOrchestrationOperateScope);
  const writable = useEnvironmentsWithScope(machines, AuthSourceControlWriteScope);
  const now = DateTime.makeUnsafe(useNowMinute());
  const sourceLabel =
    machines.find((machine) => machine.environmentId === sourceEnvironmentId)?.label ??
    "this machine";
  const destinations = moveDestinations(
    { environmentId: sourceEnvironmentId, label: sourceLabel },
    machines.map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label,
      connected: machine.connected,
      machineTransfers: machine.facts.machineTransfers,
      peerLinks: machine.peerLinks,
      links: machine.links,
      canReceive: operable.has(machine.environmentId) && writable.has(machine.environmentId),
    })),
    now,
  );
  return { sourceLabel, destinations };
}

/** The commands a move runs, bound to its source and destination machines. */
export function useMoveThreadToMachine(sourceEnvironmentId: EnvironmentId) {
  const router = useRouter();
  const transfer = useMachineTransfer();
  const describeSource = useAtomQueryRunner(machineEnvironment.moveSource, {
    reportFailure: false,
    refresh: true,
  });
  const loadMoves = useAtomQueryRunner(machineEnvironment.moves, {
    reportFailure: false,
    refresh: true,
  });
  const markMoved = useAtomCommand(machineEnvironment.markMoved, { reportFailure: false });
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const unarchive = useOrchestrationCommand(threadEnvironment.unarchive, {
    reportFailure: false,
  });

  const describe = async (threadId: ThreadId) =>
    toStep(await describeSource({ environmentId: sourceEnvironmentId, input: { threadId } }));

  const stepsFor = (destinationEnvironmentId: EnvironmentId): MoveSteps => ({
    transfer: async (input) => {
      const report = await transfer.start(destinationEnvironmentId, input);
      // The hook keeps the reason in its state, which the report view shows.
      return report === null
        ? { ok: false, message: "The transfer did not finish." }
        : { ok: true, value: report };
    },
    destinationMoves: async () => {
      const result = toStep(
        await loadMoves({ environmentId: destinationEnvironmentId, input: null }),
      );
      return result.ok ? { ok: true, value: result.value.moves } : result;
    },
    setTitle: async (threadId, title) =>
      toStep(
        await updateMetadata({
          environmentId: destinationEnvironmentId,
          input: { threadId, title },
        }),
      ),
    unarchive: async (threadId) => {
      const result = toStep(
        await unarchive({ environmentId: destinationEnvironmentId, input: { threadId } }),
      );
      if (result.ok) refreshArchivedThreadsForEnvironment(destinationEnvironmentId);
      return result;
    },
    markMoved: async ({ sourceThreadId, destinationThreadId, transferId }) => {
      const result = toStep(
        await markMoved({
          environmentId: sourceEnvironmentId,
          input: {
            threadId: sourceThreadId,
            destinationEnvironmentId,
            destinationThreadId,
            transferId,
          },
        }),
      );
      if (result.ok) refreshArchivedThreadsForEnvironment(sourceEnvironmentId);
      return result;
    },
  });

  const openThread = (environmentId: EnvironmentId, threadId: ThreadId) =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });

  return { transfer, describe, stepsFor, openThread };
}
