import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type MachineSessionSummary,
  type MachineSurveyInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useContext, useState } from "react";

import { environmentAtomList, environmentIdsKey } from "~/state/environmentAtomList";
import { machineEnvironment } from "~/state/machines";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { useEnvironmentsWithScope } from "~/state/session";
import { useNowMinute } from "../../hooks/useNowMinute";
import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { MachineTransferReport, OpenThreadLink } from "./MachineTransferReport";
import {
  checkoutFacts,
  comparePreview,
  copyWorkBlockReason,
  groupRepositories,
  localImportBlockReason,
  localImportStatusText,
  receiveBlockReason,
  type RepoCell,
  type RepoRow,
  type TransferEnd,
} from "./MachinesRepos.logic";
import {
  type LocalImportState,
  useMachineLocalImport,
  useMachineTransfer,
} from "./useMachineTransfer";
import type { MachineState } from "./useMachines";

const RECENT_SURVEY: MachineSurveyInput = {};
// The longest window the survey allows.
const OLDER_SURVEY: MachineSurveyInput = { sinceDays: 90 };

const surveyListsAtom = environmentAtomList("web-machines-repos-surveys", (environmentId) =>
  machineEnvironment.survey({ environmentId, input: RECENT_SURVEY }),
);
const olderSurveyListsAtom = environmentAtomList(
  "web-machines-repos-surveys-older",
  (environmentId) => machineEnvironment.survey({ environmentId, input: OLDER_SURVEY }),
);

const checkoutAtom = (cell: RepoCell) =>
  machineEnvironment.checkout({
    environmentId: cell.environmentId,
    input: { projectId: cell.project.projectId },
  });

export function MachinesReposSection({
  machines,
}: {
  readonly machines: ReadonlyArray<MachineState>;
}) {
  const now = DateTime.makeUnsafe(useNowMinute());
  const [includeOlder, setIncludeOlder] = useState(false);
  const surveyInput = includeOlder ? OLDER_SURVEY : RECENT_SURVEY;
  const transferable = machines.filter((machine) => machine.facts.machineTransfers === true);
  const readable = useEnvironmentsWithScope(transferable, AuthOrchestrationReadScope);
  const operable = useEnvironmentsWithScope(transferable, AuthOrchestrationOperateScope);
  const writable = useEnvironmentsWithScope(transferable, AuthSourceControlWriteScope);
  const queried = transferable.filter(
    (machine) => machine.connected && readable.has(machine.environmentId),
  );
  const results = useAtomValue(
    (includeOlder ? olderSurveyListsAtom : surveyListsAtom)(
      environmentIdsKey(queried.map(({ environmentId }) => environmentId)),
    ),
  );

  if (transferable.length === 0) return null;

  const notes = transferable.flatMap((machine) => {
    if (!machine.connected) return [`${machine.label} is not connected.`];
    if (!readable.has(machine.environmentId)) {
      return [`No permission to read ${machine.label}'s projects.`];
    }
    const result = results[queried.indexOf(machine)]!;
    if (result._tag === "Failure") {
      return [
        `Could not read ${machine.label}'s projects: ${formatEnvironmentQueryError(result.cause)}`,
      ];
    }
    return result._tag === "Success" ? [] : [`Loading ${machine.label}'s projects…`];
  });
  const rows = groupRepositories(
    queried.flatMap((machine, index) => {
      const result = results[index]!;
      return result._tag === "Success"
        ? [{ environmentId: machine.environmentId, label: machine.label, survey: result.value }]
        : [];
    }),
  );
  const ends = new Map(
    transferable.map((machine): [EnvironmentId, TransferEnd] => [
      machine.environmentId,
      {
        environmentId: machine.environmentId,
        label: machine.label,
        connected: machine.connected,
        peerLinks: machine.peerLinks,
        links: machine.links,
        canReceive: operable.has(machine.environmentId) && writable.has(machine.environmentId),
        machineTransfers: machine.facts.machineTransfers,
        canCreateThreads: operable.has(machine.environmentId),
      },
    ]),
  );

  return (
    <SettingsSection
      title="Repositories"
      headerAction={
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={includeOlder}
            onCheckedChange={(checked) => setIncludeOlder(checked === true)}
          />
          Sessions from the last 90 days
        </label>
      }
    >
      {notes.map((note) => (
        <p key={note} className="px-3 py-2 text-xs text-muted-foreground sm:px-4" role="status">
          {note}
        </p>
      ))}
      {rows.length === 0 && notes.length === 0 ? (
        <p className="px-3 py-2.5 text-sm text-muted-foreground sm:px-4">
          No git projects on these machines.
        </p>
      ) : null}
      <ul aria-label="Repositories" className="divide-y divide-border/50">
        {rows.map((row) => (
          <RepoRowView key={row.key} row={row} ends={ends} now={now} surveyInput={surveyInput} />
        ))}
      </ul>
    </SettingsSection>
  );
}

const pendingSessionsText = (count: number) =>
  count === 1 ? "1 session not yet a thread" : `${count} sessions not yet threads`;

function RepoRowView({
  row,
  ends,
  now,
  surveyInput,
}: {
  readonly row: RepoRow;
  readonly ends: ReadonlyMap<EnvironmentId, TransferEnd>;
  readonly now: DateTime.Utc;
  readonly surveyInput: MachineSurveyInput;
}) {
  const [expanded, setExpanded] = useState(false);
  // Selection order is direction: the first is the source, the second the destination.
  const [selectedKeys, setSelectedKeys] = useState<ReadonlyArray<string>>([]);
  const transfer = useMachineTransfer();
  const registry = useContext(RegistryContext);
  const machineCount = new Set(row.cells.map((cell) => cell.environmentId)).size;
  const pending = row.cells.reduce((total, cell) => total + cell.pendingSessions.length, 0);
  const selected = selectedKeys.flatMap((key) => row.cells.filter((cell) => cell.key === key));
  const toggle = (key: string, next: boolean) =>
    setSelectedKeys((current) =>
      next
        ? [...current.filter((other) => other !== key), key].slice(-2)
        : current.filter((other) => other !== key),
    );
  const refreshAfter = (cells: ReadonlyArray<RepoCell>) => {
    for (const cell of cells) {
      registry.refresh(
        machineEnvironment.survey({ environmentId: cell.environmentId, input: surveyInput }),
      );
      registry.refresh(checkoutAtom(cell));
    }
  };

  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full flex-wrap items-baseline gap-x-2 px-3 py-2.5 text-start sm:px-4"
      >
        <span className="text-sm font-medium text-foreground">{row.title}</span>
        <span className="text-xs text-muted-foreground">
          {machineCount === 1
            ? `Only on ${row.cells[0]!.machineLabel}`
            : `${machineCount} machines`}
          {pending > 0 ? ` · ${pendingSessionsText(pending)}` : ""}
        </span>
      </button>
      {expanded ? (
        <div className="space-y-3 px-3 pb-3 sm:px-4">
          <ul className="space-y-2">
            {row.cells.map((cell) => (
              <CheckoutCell
                key={cell.key}
                cell={cell}
                machine={ends.get(cell.environmentId)!}
                onImported={() => refreshAfter([cell])}
                showProject={cell.project.title !== row.title}
                selectable={row.cells.length > 1}
                selected={selectedKeys.includes(cell.key)}
                onSelectedChange={(next) => toggle(cell.key, next)}
                onShowTransfer={(transferId) => void transfer.watch(cell.environmentId, transferId)}
              />
            ))}
          </ul>
          {row.cells.length > 1 && selected.length < 2 ? (
            <p className="text-xs text-muted-foreground">
              Select two checkouts to compare them and copy between them. The first is the source.
            </p>
          ) : null}
          {selected.length === 2 ? (
            <ComparePanel
              source={selected[0]!}
              destination={selected[1]!}
              sourceEnd={ends.get(selected[0]!.environmentId)!}
              destinationEnd={ends.get(selected[1]!.environmentId)!}
              now={now}
              busy={transfer.busy}
              onSwap={() => setSelectedKeys([selected[1]!.key, selected[0]!.key])}
              onReceive={async (sessionIds, workingTree) => {
                const [source, destination] = [selected[0]!, selected[1]!];
                const report = await transfer.start(destination.environmentId, {
                  sourceEnvironmentId: source.environmentId,
                  sourceProjectId: source.project.projectId,
                  destinationProjectId: destination.project.projectId,
                  sessionIds,
                  workingTree,
                });
                if (report !== null) refreshAfter([source, destination]);
              }}
            />
          ) : null}
          {transfer.error !== null ? (
            <p className="text-xs text-destructive" role="alert">
              {transfer.error}
            </p>
          ) : null}
          {transfer.report !== null && transfer.environmentId !== null ? (
            <MachineTransferReport
              report={transfer.report}
              environmentId={transfer.environmentId}
              undoing={transfer.busy}
              onUndo={async () => {
                const report = await transfer.undo();
                if (report !== null) {
                  refreshAfter(
                    row.cells.filter((cell) => cell.environmentId === transfer.environmentId),
                  );
                }
              }}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function CheckoutCell({
  cell,
  machine,
  onImported,
  showProject,
  selectable,
  selected,
  onSelectedChange,
  onShowTransfer,
}: {
  readonly cell: RepoCell;
  readonly machine: TransferEnd;
  readonly onImported: () => void;
  readonly showProject: boolean;
  readonly selectable: boolean;
  readonly selected: boolean;
  readonly onSelectedChange: (selected: boolean) => void;
  readonly onShowTransfer: (transferId: string) => void;
}) {
  const checkout = useEnvironmentQuery(checkoutAtom(cell));
  const facts = checkout.data === null ? null : checkoutFacts(checkout.data.description);
  const [lastTransfer] = cell.project.recentTransfers;
  return (
    <li className="flex items-start gap-2.5 rounded-md border border-border/60 px-2.5 py-2">
      {selectable ? (
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onSelectedChange(checked === true)}
          aria-label={`Select ${cell.machineLabel}`}
        />
      ) : null}
      <div className="min-w-0 flex-1 space-y-0.5 text-xs text-muted-foreground">
        <p className="text-sm text-foreground">
          {cell.machineLabel}
          {showProject ? (
            <span className="text-muted-foreground"> · {cell.project.title}</span>
          ) : null}
        </p>
        <p className="break-all">{cell.project.workspaceRoot}</p>
        {facts !== null ? (
          <>
            <p>
              <span className="font-mono">{facts.branch}</span>
              {facts.shortHead === null ? null : (
                <span className="font-mono"> @ {facts.shortHead}</span>
              )}
              {facts.upstream === null ? null : ` · ${facts.upstream}`}
            </p>
            <p>
              {facts.dirtyText}
              {facts.stashes > 0 ? ` · ${facts.stashes} stashed` : ""}
            </p>
          </>
        ) : checkout.error !== null ? (
          <p className="text-destructive">Could not read the checkout: {checkout.error}</p>
        ) : (
          <p>Loading checkout…</p>
        )}
        {cell.project.checkoutError === null ? null : (
          <p className="text-destructive">{cell.project.checkoutError}</p>
        )}
        <LocalSessions cell={cell} machine={machine} onImported={onImported} />
        {lastTransfer === undefined ? null : (
          <p>
            Last transfer here: {lastTransfer.status}{" "}
            <Button size="xs" variant="link" onClick={() => onShowTransfer(lastTransfer.id)}>
              Show
            </Button>
          </p>
        )}
      </div>
    </li>
  );
}

function ComparePanel({
  source,
  destination,
  sourceEnd,
  destinationEnd,
  now,
  busy,
  onSwap,
  onReceive,
}: {
  readonly source: RepoCell;
  readonly destination: RepoCell;
  readonly sourceEnd: TransferEnd;
  readonly destinationEnd: TransferEnd;
  readonly now: DateTime.Utc;
  readonly busy: boolean;
  readonly onSwap: () => void;
  readonly onReceive: (
    sessionIds: ReadonlyArray<string>,
    workingTree: "auto" | "none",
  ) => Promise<void>;
}) {
  const sourceCheckout = useEnvironmentQuery(checkoutAtom(source));
  const destinationCheckout = useEnvironmentQuery(checkoutAtom(destination));
  const [withWork, setWithWork] = useState(false);
  const sourceFacts =
    sourceCheckout.data === null ? null : checkoutFacts(sourceCheckout.data.description);
  const preview =
    sourceCheckout.data !== null && destinationCheckout.data !== null
      ? comparePreview(sourceCheckout.data.description, destinationCheckout.data.description, {
          a: source.machineLabel,
          b: destination.machineLabel,
        })
      : null;
  const receiveBlocked = receiveBlockReason(sourceEnd, destinationEnd, now);
  const copyBlocked = copyWorkBlockReason(sourceEnd, destinationEnd, sourceFacts, now);

  return (
    <div className="space-y-3 rounded-md border border-border/60 px-2.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-foreground">
          From {source.machineLabel} to {destination.machineLabel}
        </span>
        <Button size="xs" variant="outline" onClick={onSwap}>
          Swap
        </Button>
      </div>
      {preview === null ? (
        <p className="text-xs text-muted-foreground">Loading both checkouts…</p>
      ) : (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>{preview.head}</p>
          {preview.paths.length === 0 ? (
            <p>No uncommitted differences.</p>
          ) : (
            <ul aria-label="Changed paths" className="space-y-0.5">
              {preview.paths.map((entry) => (
                <li key={entry.path} className="flex gap-2">
                  <span className="shrink-0">{entry.status}</span>
                  <span className="min-w-0 break-all font-mono text-foreground">{entry.path}</span>
                </li>
              ))}
            </ul>
          )}
          {preview.hiddenPaths > 0 ? <p>And {preview.hiddenPaths} more.</p> : null}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={busy || copyBlocked !== null}
          onClick={() => void onReceive([], "auto")}
        >
          Copy uncommitted work to {destination.machineLabel}
        </Button>
        {copyBlocked === null ? null : (
          <span className="text-xs text-muted-foreground">{copyBlocked}</span>
        )}
      </div>
      {source.pendingSessions.length > 0 ? (
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={withWork}
              onCheckedChange={(checked) => setWithWork(checked === true)}
            />
            Also copy uncommitted work
          </label>
          {receiveBlocked === null ? null : (
            <p className="text-xs text-muted-foreground">{receiveBlocked}</p>
          )}
          <ul aria-label="Sessions not yet threads" className="space-y-1">
            {source.pendingSessions.map((session) => (
              <SessionRow
                key={session.sessionId}
                session={session}
                disabled={busy || receiveBlocked !== null}
                onBring={() => void onReceive([session.sessionId], withWork ? "auto" : "none")}
              />
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No sessions on {source.machineLabel} that are not threads yet.
        </p>
      )}
    </div>
  );
}

function SessionRow({
  session,
  disabled,
  onBring,
}: {
  readonly session: MachineSessionSummary;
  readonly disabled: boolean;
  readonly onBring: () => void;
}) {
  return (
    <li className="flex items-center gap-2 text-xs">
      <span className="min-w-0 flex-1 truncate text-foreground">
        {session.title ?? session.sessionId}
      </span>
      {session.lastTimestamp === null ? null : (
        <span className="shrink-0 text-muted-foreground max-sm:hidden">
          {new Date(session.lastTimestamp).toLocaleString()}
        </span>
      )}
      <Button size="xs" variant="outline" disabled={disabled} onClick={onBring}>
        Bring over
      </Button>
    </li>
  );
}

/** Sessions on the cell's machine that are not threads yet, each importable where it is. */
function LocalSessions({
  cell,
  machine,
  onImported,
}: {
  readonly cell: RepoCell;
  readonly machine: TransferEnd;
  readonly onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const local = useMachineLocalImport();
  const pendingIds = new Set(cell.pendingSessions.map((session) => session.sessionId));
  // Imported sessions leave the survey once it refreshes; their results stay listed here.
  const settled = [...local.states.values()].filter(
    (state) =>
      state.kind === "done" &&
      state.result.threadId !== null &&
      !pendingIds.has(state.session.sessionId),
  );
  if (cell.pendingSessions.length === 0 && settled.length === 0) return null;
  const blocked = localImportBlockReason(machine);
  const importSession = async (session: MachineSessionSummary) => {
    const imported = await local.importSession(cell.environmentId, cell.project.projectId, session);
    if (imported) onImported();
  };
  return (
    <div className="space-y-1">
      {cell.pendingSessions.length > 0 ? (
        <Button size="xs" variant="link" aria-expanded={open} onClick={() => setOpen(!open)}>
          {pendingSessionsText(cell.pendingSessions.length)}
          {cell.project.sessionsTruncated ? " (more not listed)" : ""}
        </Button>
      ) : null}
      {open && blocked !== null ? <p>{blocked}</p> : null}
      {open || settled.length > 0 ? (
        <ul aria-label={`Sessions on ${cell.machineLabel}`} className="space-y-1">
          {(open ? cell.pendingSessions : []).map((session) => (
            <LocalSessionRow
              key={session.sessionId}
              session={session}
              state={local.states.get(session.sessionId)}
              environmentId={cell.environmentId}
              disabled={blocked !== null}
              onImport={() => void importSession(session)}
            />
          ))}
          {settled.map((state) => (
            <LocalSessionRow
              key={state.session.sessionId}
              session={state.session}
              state={state}
              environmentId={cell.environmentId}
              disabled={false}
              onImport={() => undefined}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function LocalSessionRow({
  session,
  state,
  environmentId,
  disabled,
  onImport,
}: {
  readonly session: MachineSessionSummary;
  readonly state: LocalImportState | undefined;
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onImport: () => void;
}) {
  const threadId = state?.kind === "done" ? state.result.threadId : null;
  const canTry = state === undefined || (state.kind !== "running" && threadId === null);
  return (
    <li className="flex flex-wrap items-center gap-x-2 text-xs">
      <span className="min-w-0 flex-1 truncate text-foreground">
        {session.title ?? session.sessionId}
      </span>
      {session.lastTimestamp === null ? null : (
        <span className="shrink-0 max-sm:hidden">
          {new Date(session.lastTimestamp).toLocaleString()}
        </span>
      )}
      {state?.kind === "running" ? <span role="status">Importing…</span> : null}
      {state?.kind === "done" ? (
        <span role="status">{localImportStatusText(state.result)}</span>
      ) : null}
      {canTry ? (
        <Button size="xs" variant="outline" disabled={disabled} onClick={onImport}>
          Import
        </Button>
      ) : null}
      {threadId === null ? null : (
        <OpenThreadLink environmentId={environmentId} threadId={threadId} />
      )}
      {state?.kind === "failed" ? (
        <span className="basis-full text-destructive" role="alert">
          {state.error}
        </span>
      ) : null}
    </li>
  );
}
