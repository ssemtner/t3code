import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MachineTransferReport as TransferReport,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useThreadShell } from "~/state/entities";
import { machineEnvironment } from "~/state/machines";
import { useEnvironmentQuery } from "~/state/query";
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
import { Radio, RadioGroup } from "../ui/radio-group";
import { MachineTransferReport } from "./MachineTransferReport";
import {
  finishMove,
  type MoveDestination,
  type MoveFinish,
  moveSourceRefusalCopy,
  NOT_CARRIED,
  runMoveThread,
} from "./moveThread.logic";
import { moveThreadDialogAtom } from "./moveThreadDialogState";
import { useMoveDestinations, useMoveThreadToMachine } from "./useMoveThreadToMachine";

export function MoveThreadDialogHost() {
  const threadRef = useAtomValue(moveThreadDialogAtom);
  if (threadRef === null) return null;
  return (
    <MoveThreadDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(moveThreadDialogAtom, null)}
    />
  );
}

type Phase =
  | { readonly kind: "pick" }
  | { readonly kind: "running" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "copied"; readonly message: string; readonly finish: MoveFinish }
  | { readonly kind: "finishing"; readonly finish: MoveFinish }
  | { readonly kind: "moved" };

function MoveThreadDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const thread = useThreadShell(threadRef);
  const title = thread?.title ?? "this thread";
  const { sourceLabel, destinations } = useMoveDestinations(threadRef.environmentId);
  const move = useMoveThreadToMachine(threadRef.environmentId);
  const source = useEnvironmentQuery(
    machineEnvironment.moveSource({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const [destinationId, setDestinationId] = useState<EnvironmentId | null>(null);
  const [copyWorkingTree, setCopyWorkingTree] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  // A double click can start two moves before a re-render; this guard is synchronous.
  const started = useRef(false);

  const destination =
    destinations.find((item) => item.environmentId === destinationId && item.reason === null) ??
    null;
  const refusal = source.data === null ? null : moveSourceRefusalCopy(source.data.refusal);
  const blocked = source.error ?? refusal;

  const start = async () => {
    if (started.current || destination === null) return;
    started.current = true;
    move.transfer.reset();
    setPhase({ kind: "running" });
    const described = await move.describe(threadRef.threadId);
    const result = described.ok
      ? await runMoveThread(
          {
            source: described.value,
            sourceEnvironmentId: threadRef.environmentId,
            title,
            copyWorkingTree,
          },
          move.stepsFor(destination.environmentId),
        )
      : ({ kind: "failed", message: described.message, report: null } as const);
    started.current = false;
    switch (result.kind) {
      case "failed":
        setPhase({ kind: "failed", message: result.message });
        return;
      case "copied":
        setPhase({ kind: "copied", message: result.message, finish: result.finish });
        return;
      case "moved":
        void move.openThread(destination.environmentId, result.destinationThreadId);
        // Work left as refs needs the user's attention; anything else is done.
        if (result.report.workingTree?.action === "refs-only") setPhase({ kind: "moved" });
        else onClose();
    }
  };

  const retryFinish = async (finish: MoveFinish) => {
    if (started.current || destination === null) return;
    started.current = true;
    setPhase({ kind: "finishing", finish });
    const finished = await finishMove(finish, move.stepsFor(destination.environmentId));
    started.current = false;
    if (!finished.ok) {
      setPhase({ kind: "copied", message: finished.message, finish });
      return;
    }
    void move.openThread(destination.environmentId, finish.destinationThreadId);
    onClose();
  };

  const busy = phase.kind === "running" || phase.kind === "finishing";
  const report = move.transfer.report;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Move to machine</DialogTitle>
          <DialogDescription>
            Continue &ldquo;{title}&rdquo; on another machine. The original on {sourceLabel} is
            archived once the copy is in place.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {phase.kind === "pick" ? (
            <div className="space-y-4">
              {blocked === null ? null : (
                <p role="alert" className="text-sm text-destructive">
                  {blocked}
                </p>
              )}
              <DestinationPicker
                destinations={destinations}
                value={destinationId}
                onChange={setDestinationId}
              />
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={copyWorkingTree}
                  onCheckedChange={(checked) => setCopyWorkingTree(checked === true)}
                />
                Also copy uncommitted work
              </label>
              <NotCarried />
            </div>
          ) : (
            <div className="space-y-3" aria-live="polite">
              {phase.kind === "failed" ? (
                <p role="alert" className="text-sm text-destructive">
                  {move.transfer.error ?? phase.message}
                </p>
              ) : null}
              {phase.kind === "copied" ? (
                <p role="alert" className="text-sm text-destructive">
                  Copied; the original is still active. {phase.message}
                </p>
              ) : null}
              {phase.kind === "moved" ? (
                <p className="text-sm">
                  Moved. Your uncommitted work was kept as refs on {destination?.label}; see below.
                </p>
              ) : null}
              <TransferStatus report={report} destination={destination} />
            </div>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          {phase.kind === "pick" ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                disabled={destination === null || blocked !== null || source.data === null}
                onClick={() => void start()}
              >
                {destination === null ? "Pick a machine" : `Move to ${destination.label}`}
              </Button>
            </>
          ) : phase.kind === "failed" ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button onClick={() => setPhase({ kind: "pick" })}>Back</Button>
            </>
          ) : phase.kind === "copied" ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button onClick={() => void retryFinish(phase.finish)}>Retry archive</Button>
            </>
          ) : (
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {busy ? "Moving…" : "Done"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function TransferStatus({
  report,
  destination,
}: {
  readonly report: TransferReport | null;
  readonly destination: MoveDestination | null;
}) {
  if (destination === null) return null;
  if (report === null) {
    return <p className="text-sm text-muted-foreground">Starting on {destination.label}…</p>;
  }
  return <MachineTransferReport report={report} environmentId={destination.environmentId} />;
}

/** Machines a thread can move to, each disabled with its reason when it cannot. */
export function DestinationPicker({
  destinations,
  value,
  onChange,
}: {
  readonly destinations: ReadonlyArray<MoveDestination>;
  readonly value: EnvironmentId | null;
  readonly onChange: (environmentId: EnvironmentId) => void;
}) {
  if (destinations.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No other machines. Add one in{" "}
        <Link to="/settings/connections" className="underline underline-offset-2">
          Settings → Connections
        </Link>
        .
      </p>
    );
  }
  const anyBlocked = destinations.some((item) => item.reason !== null);
  return (
    <div className="space-y-1.5">
      <RadioGroup
        aria-label="Destination machine"
        value={value}
        onValueChange={(next) => onChange(next as EnvironmentId)}
      >
        {destinations.map((item) => (
          <label key={item.environmentId} className="flex items-start gap-2 text-sm">
            <Radio value={item.environmentId} disabled={item.reason !== null} />
            <span className="min-w-0">
              <span className="block font-medium">{item.label}</span>
              {item.reason === null ? null : (
                <span className="block text-xs text-muted-foreground">{item.reason}</span>
              )}
            </span>
          </label>
        ))}
      </RadioGroup>
      {anyBlocked ? (
        <p className="text-xs text-muted-foreground">
          Links and the Linked environments beta are on the{" "}
          <Link to="/machines" className="underline underline-offset-2">
            Machines
          </Link>{" "}
          page.
        </p>
      ) : null}
    </div>
  );
}

export function NotCarried() {
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium text-foreground">What does not come along</h3>
      <ul className="ms-4 list-disc space-y-0.5 text-xs text-muted-foreground">
        {NOT_CARRIED.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
