import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, MachineTransferReport as TransferReport } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { buildThreadRouteParams } from "~/threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { transferReportView } from "./MachinesRepos.logic";

const TONE_BADGE = {
  running: { variant: "info", label: "Running" },
  failed: { variant: "error", label: "Failed" },
  done: { variant: "success", label: "Finished" },
} as const;

/** Any transfer's report. `environmentId` is the destination, where imported threads live. */
export function MachineTransferReport({
  report,
  environmentId,
  onUndo,
  undoing = false,
}: {
  readonly report: TransferReport;
  readonly environmentId: EnvironmentId;
  readonly onUndo?: () => void;
  readonly undoing?: boolean;
}) {
  const view = transferReportView(report);
  const badge = TONE_BADGE[view.tone];
  const tree = view.workingTree;
  return (
    <div className="space-y-2 text-sm" role="status">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <span className={view.tone === "failed" ? "text-destructive" : "text-foreground"}>
          {view.headline}
        </span>
        {view.canUndo && onUndo ? (
          <Button size="xs" variant="outline" disabled={undoing} onClick={onUndo}>
            {undoing ? "Undoing…" : "Undo"}
          </Button>
        ) : null}
      </div>
      {tree === null ? null : (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            {tree.headline}
            {tree.headRelation === null ? null : ` ${tree.headRelation}`}
          </p>
          {tree.blocking.length > 0 ? (
            <ul className="ms-4 list-disc break-all">
              {tree.blocking.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          ) : null}
          {tree.action === "applied" ? <p>{tree.summary}</p> : null}
          {tree.refs.length > 0 ? (
            <p className="break-all">
              Kept as refs: <code>{tree.refs.join(", ")}</code>
            </p>
          ) : null}
          {tree.safetyRef === null ? null : (
            <p className="break-all">
              Earlier state saved at <code>{tree.safetyRef}</code>
            </p>
          )}
        </div>
      )}
      {view.sessions.length > 0 ? (
        <ul aria-label="Sessions" className="space-y-1 text-xs">
          {view.sessions.map((session) => (
            <li key={session.sessionId} className="flex flex-wrap items-center gap-x-2">
              <span className="text-foreground">{session.status}</span>
              <span className="truncate font-mono text-muted-foreground">
                {session.sessionId.slice(0, 8)}
              </span>
              {session.reason === null ? null : (
                <span className="text-muted-foreground">{session.reason}</span>
              )}
              {session.threadId === null ? null : (
                <Button
                  size="xs"
                  variant="link"
                  render={
                    <Link
                      to="/$environmentId/$threadId"
                      params={buildThreadRouteParams(
                        scopeThreadRef(environmentId, session.threadId),
                      )}
                    />
                  }
                >
                  Open
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
