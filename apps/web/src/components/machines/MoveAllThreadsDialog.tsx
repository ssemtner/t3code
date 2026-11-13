import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import { type EnvironmentId, isListedThreadLineage, type ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { useRef, useState } from "react";

import { useThreadShells } from "~/state/entities";
import { machineEnvironment } from "~/state/machines";
import { formatEnvironmentQueryError } from "~/state/query";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Button } from "../ui/button";
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
  finishMove,
  type MoveAllThread,
  type MoveAllThreadResult,
  planMoveAll,
  runMoveAll,
} from "./moveThread.logic";
import { DestinationPicker, NotCarried } from "./MoveThreadDialog";
import type { MachineState } from "./useMachines";
import { useMoveDestinations, useMoveThreadToMachine } from "./useMoveThreadToMachine";

/** Each thread's move facts on one machine; the key is the machine, then the thread ids. */
const moveSourcesAtom = Atom.family((key: string) => {
  const [environmentId, ...threadIds] = key.split("\n") as [EnvironmentId, ...ThreadId[]];
  return Atom.make((get) =>
    threadIds.map((threadId) =>
      get(machineEnvironment.moveSource({ environmentId, input: { threadId } })),
    ),
  ).pipe(Atom.withLabel(`machines:move-sources:${key}`));
});

/** Opens the move-all dialog for a machine whose server can hand threads over. */
export function MoveAllThreadsAction({ machine }: { readonly machine: MachineState }) {
  const [open, setOpen] = useState(false);
  if (!machine.connected || machine.facts.machineTransfers !== true) return null;
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        Move threads off…
      </Button>
      {open ? <MoveAllThreadsDialog machine={machine} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function MoveAllThreadsDialog({
  machine,
  onClose,
}: {
  readonly machine: MachineState;
  readonly onClose: () => void;
}) {
  const shells = useThreadShells().filter(
    (thread) =>
      thread.environmentId === machine.environmentId &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      isListedThreadLineage(thread.lineage),
  );
  const sources = useAtomValue(
    moveSourcesAtom([machine.environmentId, ...shells.map((thread) => thread.id)].join("\n")),
  );
  const threads = shells.map((thread, index): MoveAllThread => {
    const source = sources[index]!;
    return {
      threadId: thread.id,
      title: thread.title,
      isRunning: !threadRuntimeCanArchive(thread.runtime),
      source: AsyncResult.isSuccess(source)
        ? { ok: true, value: source.value }
        : AsyncResult.isFailure(source)
          ? { ok: false, message: formatEnvironmentQueryError(source.cause) }
          : null,
    };
  });
  const plan = planMoveAll(threads);
  const toMove = plan.batches.flatMap((batch) => batch.threads);
  const { destinations } = useMoveDestinations(machine.environmentId);
  const move = useMoveThreadToMachine(machine.environmentId);
  const [destinationId, setDestinationId] = useState<EnvironmentId | null>(null);
  // The threads a run started with: moved ones leave the live list as they are archived.
  const [moving, setMoving] = useState<typeof toMove | null>(null);
  const [results, setResults] = useState<ReadonlyMap<ThreadId, MoveAllThreadResult>>(new Map());
  const [running, setRunning] = useState(false);
  // A double click can start two runs before a re-render; this guard is synchronous.
  const started = useRef(false);
  const destination =
    destinations.find((item) => item.environmentId === destinationId && item.reason === null) ??
    null;

  const record = (threadId: ThreadId, result: MoveAllThreadResult) =>
    setResults((current) => new Map(current).set(threadId, result));

  const start = async () => {
    if (started.current || destination === null || toMove.length === 0) return;
    started.current = true;
    setRunning(true);
    setMoving(toMove);
    await runMoveAll(
      plan.batches,
      machine.environmentId,
      move.stepsFor(destination.environmentId),
      record,
    );
    setRunning(false);
  };

  const retry = async (threadId: ThreadId, result: MoveAllThreadResult) => {
    if (result.kind !== "copied" || destination === null) return;
    const finished = await finishMove(result.finish, move.stepsFor(destination.environmentId));
    record(
      threadId,
      finished.ok
        ? { kind: "moved", destinationThreadId: result.finish.destinationThreadId }
        : { ...result, message: finished.message },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !running) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Move threads off {machine.label}</DialogTitle>
          <DialogDescription>
            Each idle Claude thread continues on the machine you pick, and its original is archived.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {moving === null ? (
            <div className="space-y-4">
              <DestinationPicker
                destinations={destinations}
                value={destinationId}
                onChange={setDestinationId}
              />
              <ThreadList
                title={`Will move (${toMove.length})`}
                rows={toMove.map((thread) => ({ ...thread, note: null }))}
              />
              <ThreadList
                title={`Skipped (${plan.skipped.length})`}
                rows={plan.skipped.map((thread) => ({ ...thread, note: thread.reason }))}
              />
              {plan.loading > 0 ? (
                <p className="text-xs text-muted-foreground">Checking {plan.loading} threads…</p>
              ) : null}
              <NotCarried />
            </div>
          ) : (
            <ul className="space-y-1.5" aria-live="polite">
              {moving.map((thread) => {
                const result = results.get(thread.threadId);
                return (
                  <li key={thread.threadId} className="text-sm">
                    <span className="font-medium text-foreground">{thread.title}</span>
                    <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      {result === undefined ? (
                        running ? (
                          "Waiting…"
                        ) : (
                          "Not moved"
                        )
                      ) : result.kind === "failed" ? (
                        <span className="text-destructive">{result.message}</span>
                      ) : result.kind === "copied" ? (
                        <>
                          <span className="text-destructive">
                            Copied; original still active. {result.message}
                          </span>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={running}
                            onClick={() => void retry(thread.threadId, result)}
                          >
                            Retry archive
                          </Button>
                        </>
                      ) : (
                        <>
                          Moved
                          {destination === null ? null : (
                            <Button
                              size="xs"
                              variant="link"
                              render={
                                <Link
                                  to="/$environmentId/$threadId"
                                  params={buildThreadRouteParams(
                                    scopeThreadRef(
                                      destination.environmentId,
                                      result.destinationThreadId,
                                    ),
                                  )}
                                />
                              }
                            >
                              Open
                            </Button>
                          )}
                        </>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          {moving === null ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                disabled={destination === null || toMove.length === 0 || plan.loading > 0}
                onClick={() => void start()}
              >
                {toMove.length === 0
                  ? "Nothing to move"
                  : `Move ${toMove.length} ${toMove.length === 1 ? "thread" : "threads"}`}
              </Button>
            </>
          ) : (
            <Button variant="outline" disabled={running} onClick={onClose}>
              {running ? "Moving…" : "Close"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ThreadList({
  title,
  rows,
}: {
  readonly title: string;
  readonly rows: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly title: string;
    readonly note: string | null;
  }>;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <h3 className="text-xs font-medium text-foreground">{title}</h3>
      <ul className="max-h-48 space-y-1 overflow-y-auto">
        {rows.map((row) => (
          <li key={row.threadId} className="text-sm">
            <span className="block truncate">{row.title}</span>
            {row.note === null ? null : (
              <span className="block text-xs text-muted-foreground">{row.note}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
