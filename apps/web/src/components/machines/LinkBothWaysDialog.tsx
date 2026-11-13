import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AuthMcpClientAccess } from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import { useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { useAtomCommand } from "~/state/use-atom-command";
import { LinkAccessPicker } from "../settings/LinkAccessPicker";
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
import { TurnOnLinksAction } from "./MachineListSection";
import {
  type LinkPairCreate,
  type LinkPairOutcome,
  type LinkPairPlan,
  linkFailureMessage,
  machinesWithLinksOff,
  planLinkBothWays,
  runLinkPairs,
} from "./machines.logic";
import type { MachineState } from "./useMachines";

const pairKey = (pair: LinkPairPlan) =>
  `${pair.source.environmentId}\n${pair.target.environmentId}`;

const pairName = (pair: LinkPairPlan) => `${pair.source.label} → ${pair.target.label}`;

type Run =
  | { readonly phase: "review" }
  | {
      readonly phase: "running" | "done";
      readonly pairs: ReadonlyArray<LinkPairCreate>;
      readonly outcomes: ReadonlyMap<string, LinkPairOutcome>;
    };

/** Shows what linking the selection both ways would do, then links each missing pair in turn. */
export function LinkBothWaysDialog({
  machines,
  now,
  onClose,
}: {
  readonly machines: ReadonlyArray<MachineState>;
  readonly now: DateTime.Utc;
  readonly onClose: () => void;
}) {
  const [access, setAccess] = useState<AuthMcpClientAccess>("approval-required");
  const [run, setRun] = useState<Run>({ phase: "review" });
  // A double click can start two runs before a re-render; this guard is synchronous.
  const started = useRef(false);
  const link = useAtomCommand(peerLinkEnvironment.link, {
    label: "link environment",
    reportFailure: false,
  });
  const plan = planLinkBothWays(machines, now);
  const toCreate = plan.filter((pair): pair is LinkPairCreate => pair.kind === "create");
  const linked = plan.filter((pair) => pair.kind === "linked");
  const blocked = plan.flatMap((pair) => (pair.kind === "blocked" ? [pair] : []));
  const linksOff = machinesWithLinksOff(machines);

  const start = async () => {
    if (started.current || toCreate.length === 0) return;
    started.current = true;
    const pairs = toCreate;
    setRun({ phase: "running", pairs, outcomes: new Map() });
    await runLinkPairs(
      pairs,
      {
        mint: async ({ target }) => {
          const minted = await mintPairingCodeOn(target.environmentId, access);
          return Result.isSuccess(minted)
            ? { ok: true, value: minted.success }
            : { ok: false, message: linkFailureMessage(minted.failure) };
        },
        link: async ({ source, target, urls: [url, ...alternateUrls] }, pairingCode) => {
          const result = await link({
            environmentId: source.environmentId,
            input: {
              url,
              ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
              expectedEnvironmentId: target.environmentId,
              expectedLabel: target.label,
              pairingCode,
              access,
            },
          });
          return result._tag === "Success"
            ? { ok: true, value: result.value }
            : { ok: false, message: linkFailureMessage(squashAtomCommandFailure(result)) };
        },
      },
      (outcome) =>
        setRun((current) =>
          current.phase === "review"
            ? current
            : {
                ...current,
                outcomes: new Map(current.outcomes).set(pairKey(outcome.pair), outcome),
              },
        ),
    );
    setRun((current) => (current.phase === "running" ? { ...current, phase: "done" } : current));
  };

  const running = run.phase === "running";
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !running) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link selected both ways</DialogTitle>
          <DialogDescription>
            Each machine gets a link to every other selected machine. Agents on one can then work on
            the other, up to the access you pick.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {run.phase === "review" ? (
            <div className="space-y-4">
              <PairList
                title="Will link"
                pairs={toCreate}
                note={(pair) => (pair.renew ? "renews" : null)}
              />
              <PairList title="Already linked" pairs={linked} />
              <PairList
                title="Cannot link"
                pairs={blocked}
                note={(pair) => pair.reason}
                tone="muted"
              />
              {linksOff.length > 0 ? (
                <div className="space-y-1.5">
                  <h3 className="text-xs font-medium text-foreground">
                    Linked environments is off
                  </h3>
                  <ul className="space-y-1">
                    {linksOff.map((machine) => (
                      <li
                        key={machine.environmentId}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span className="min-w-0 truncate">{machine.label}</span>
                        <TurnOnLinksAction machine={machine} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {toCreate.length > 0 ? (
                <LinkAccessPicker value={access} onChange={setAccess} />
              ) : null}
            </div>
          ) : (
            <ul className="space-y-1.5" aria-live="polite">
              {run.pairs.map((pair) => {
                const outcome = run.outcomes.get(pairKey(pair));
                return (
                  <li key={pairKey(pair)} className="text-sm">
                    <span className="font-medium text-foreground">{pairName(pair)}</span>
                    <span
                      className={cn(
                        "block text-xs text-muted-foreground",
                        outcome?.ok === false && "text-destructive",
                      )}
                    >
                      {outcome === undefined ? "Waiting…" : outcome.ok ? "Linked" : outcome.message}
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
              <Button disabled={toCreate.length === 0} onClick={() => void start()}>
                {toCreate.length === 0
                  ? "Nothing to link"
                  : `Link ${toCreate.length} ${toCreate.length === 1 ? "pair" : "pairs"}`}
              </Button>
            </>
          ) : (
            <Button variant="outline" disabled={running} onClick={onClose}>
              {running ? "Linking…" : "Close"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function PairList<T extends LinkPairPlan>({
  title,
  pairs,
  note,
  tone = "default",
}: {
  readonly title: string;
  readonly pairs: ReadonlyArray<T>;
  readonly note?: (pair: T) => string | null;
  readonly tone?: "default" | "muted";
}) {
  if (pairs.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <h3 className="text-xs font-medium text-foreground">{title}</h3>
      <ul className="space-y-1">
        {pairs.map((pair) => {
          const detail = note?.(pair) ?? null;
          return (
            <li
              key={pairKey(pair)}
              className={cn("text-sm", tone === "muted" && "text-muted-foreground")}
            >
              {pairName(pair)}
              {detail ? (
                <span className="block text-xs text-muted-foreground">{detail}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
