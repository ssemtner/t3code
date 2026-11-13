import { RegistryContext } from "@effect/atom-react";
import {
  type AtomCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, MachineReceiveInput, MachineTransferReport } from "@t3tools/contracts";
import { useContext, useEffect, useRef, useState } from "react";

import { machineEnvironment } from "~/state/machines";
import { transferFailureMessage } from "./MachinesRepos.logic";

export interface MachineTransferState {
  /** The destination the transfer runs on. */
  readonly environmentId: EnvironmentId | null;
  readonly report: MachineTransferReport | null;
  readonly error: string | null;
  /** A request is in flight or the report is still running. */
  readonly busy: boolean;
}

type Step<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

const IDLE: MachineTransferState = { environmentId: null, report: null, error: null, busy: false };
// The server holds a report request while the transfer runs; this only stops a tight loop.
const MIN_POLL_INTERVAL_MS = 1_000;

/**
 * One transfer at a time: `start` runs a receive on the destination and `watch` follows an
 * existing one; both resolve with the settled report, or null when it failed or was replaced.
 */
export function useMachineTransfer() {
  const registry = useContext(RegistryContext);
  const [state, setState] = useState<MachineTransferState>(IDLE);
  // Bumped on every start, watch, reset and unmount, so a superseded poll loop stops.
  const generation = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops the report poll loop on unmount
  useEffect(() => () => void generation.current++, []);

  const run = async <A, E, W>(command: AtomCommand<W, A, E>, value: W): Promise<Step<A>> => {
    const result = await runAtomCommand(registry, command, value, {
      label: command.label,
      reportFailure: false,
      reportDefect: true,
    });
    if (result._tag === "Success") return { ok: true, value: result.value };
    return {
      ok: false,
      error: isAtomCommandInterrupted(result)
        ? "Stopped."
        : transferFailureMessage(squashAtomCommandFailure(result)),
    };
  };

  const follow = async (
    environmentId: EnvironmentId,
    first: MachineTransferReport,
    current: number,
  ): Promise<MachineTransferReport | null> => {
    let report = first;
    while (report.status === "running") {
      if (generation.current !== current) return null;
      setState({ environmentId, report, error: null, busy: true });
      const startedAt = Date.now();
      const next = await run(machineEnvironment.transferReport, {
        environmentId,
        input: { transferId: report.transferId, wait: true },
      });
      if (generation.current !== current) return null;
      if (!next.ok) {
        setState({ environmentId, report, error: next.error, busy: false });
        return null;
      }
      report = next.value;
      const elapsed = Date.now() - startedAt;
      if (report.status === "running" && elapsed < MIN_POLL_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_POLL_INTERVAL_MS - elapsed));
      }
    }
    if (generation.current !== current) return null;
    setState({ environmentId, report, error: null, busy: false });
    return report;
  };

  const begin = async (
    environmentId: EnvironmentId,
    request: () => Promise<Step<MachineTransferReport>>,
  ) => {
    const current = ++generation.current;
    setState({ environmentId, report: null, error: null, busy: true });
    const first = await request();
    if (generation.current !== current) return null;
    if (!first.ok) {
      setState({ environmentId, report: null, error: first.error, busy: false });
      return null;
    }
    return follow(environmentId, first.value, current);
  };

  const start = (environmentId: EnvironmentId, input: MachineReceiveInput) =>
    begin(environmentId, () => run(machineEnvironment.receive, { environmentId, input }));

  const watch = (environmentId: EnvironmentId, transferId: string) =>
    begin(environmentId, () =>
      run(machineEnvironment.transferReport, {
        environmentId,
        input: { transferId, wait: false },
      }),
    );

  const undo = async (): Promise<MachineTransferReport | null> => {
    const { environmentId, report } = state;
    if (environmentId === null || report === null) return null;
    const current = ++generation.current;
    setState({ environmentId, report, error: null, busy: true });
    const result = await run(machineEnvironment.undo, {
      environmentId,
      input: { transferId: report.transferId },
    });
    if (generation.current !== current) return null;
    setState(
      result.ok
        ? { environmentId, report: result.value, error: null, busy: false }
        : { environmentId, report, error: result.error, busy: false },
    );
    return result.ok ? result.value : null;
  };

  const reset = () => {
    generation.current++;
    setState(IDLE);
  };

  return { ...state, start, watch, undo, reset };
}
