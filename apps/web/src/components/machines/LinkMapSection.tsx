import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useId, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { cn } from "~/lib/utils";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNowMinute } from "../../hooks/useNowMinute";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { LinkBothWaysDialog } from "./LinkBothWaysDialog";
import {
  buildLinkGraph,
  type LinkGraphEdge,
  type LinkGraphNode,
  layoutMapNodes,
  MAP_HEIGHT,
  MAP_LABEL_OFFSET,
  MAP_NODE_RADIUS,
  MAP_SUBLABEL_OFFSET,
  MAP_WIDTH,
  mapEdgeSegment,
  mapNodeLabel,
  type PeerLinkTone,
} from "./machines.logic";
import type { MachineState } from "./useMachines";

const TONES: ReadonlyArray<PeerLinkTone> = ["live", "expiring", "broken", "unreachable"];

const EDGE_STROKE: Record<PeerLinkTone, string> = {
  live: "stroke-foreground/55",
  expiring: "stroke-warning",
  broken: "stroke-destructive",
  unreachable: "stroke-muted-foreground/70",
};

const ARROW_FILL: Record<PeerLinkTone, string> = {
  live: "fill-foreground/55",
  expiring: "fill-warning",
  broken: "fill-destructive",
  unreachable: "fill-muted-foreground/70",
};

const DASHED_TONES = new Set<PeerLinkTone>(["broken", "unreachable"]);

/** What a node's second line says: why its links are missing or limited, or nothing. */
function nodeNote(node: LinkGraphNode, machine: MachineState | undefined): string | null {
  if (!node.saved || machine === undefined) return "Not saved here";
  if (!machine.connected) return "Not connected";
  if (machine.peerLinks === "unsupported") return "No linking";
  if (machine.peerLinks === "off") return "Links off";
  if (machine.links.kind === "failed") return "Links unreadable";
  if (machine.links.kind === "unavailable") return "No permission";
  return null;
}

function edgeDescription(edge: LinkGraphEdge): string {
  return [
    `${edge.source.label} to ${edge.target.label}`,
    accessConfig[edge.link.access].label,
    edge.view.fenced ? "Fenced" : "Not fenced",
    edge.view.status,
  ].join(", ");
}

export function LinkMapSection({
  machines,
  selected,
}: {
  readonly machines: ReadonlyArray<MachineState>;
  readonly selected: ReadonlyArray<MachineState>;
}) {
  const nowMinute = useNowMinute();
  const now = DateTime.makeUnsafe(nowMinute);
  const { nodes, edges } = buildLinkGraph(machines, now);
  const [focusedEdgeKey, setFocusedEdgeKey] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const discovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const refreshDiscovery = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const openDialog = () => {
    // Machines on T3 Connect are listed only once asked for, and their address may be the only one.
    if (discovery.environments.size === 0 && !discovery.refreshing) void refreshDiscovery();
    setDialogOpen(true);
  };
  const machineById = new Map(machines.map((machine) => [machine.environmentId, machine]));
  const notes = machines.flatMap((machine) => {
    if (!machine.connected) return [];
    switch (machine.links.kind) {
      case "loading":
        return [`Loading ${machine.label}'s links…`];
      case "failed":
        return [`Could not read ${machine.label}'s links: ${machine.links.message}`];
      case "unavailable":
        return machine.peerLinks === "unsupported"
          ? [`${machine.label} runs a version without linked environments.`]
          : [`No permission to read ${machine.label}'s links.`];
      case "ready":
        return [];
    }
  });

  return (
    <SettingsSection
      title="Links"
      headerAction={
        <div className="flex items-center gap-2">
          {selected.length < 2 ? (
            <span className="text-xs text-muted-foreground max-sm:hidden">
              Select two or more machines
            </span>
          ) : null}
          <Button size="xs" disabled={selected.length < 2} onClick={openDialog}>
            Link selected both ways
          </Button>
        </div>
      }
    >
      <LinkMap
        nodes={nodes}
        edges={edges}
        machineById={machineById}
        selectedIds={new Set(selected.map((machine) => machine.environmentId))}
        focusedEdgeKey={focusedEdgeKey}
        onFocusEdge={setFocusedEdgeKey}
      />
      <ul aria-label="Links" className="divide-y divide-border/50">
        {edges.map((edge) => (
          <LinkRow
            key={edge.key}
            edge={edge}
            highlighted={edge.key === focusedEdgeKey}
            canUnlink={machineById.get(edge.source.environmentId)?.canUnlink === true}
          />
        ))}
        {edges.length === 0 && notes.length === 0 ? (
          <li className="px-3 py-2.5 text-sm text-muted-foreground sm:px-4">
            No links yet. Select machines above and link them both ways.
          </li>
        ) : null}
        {notes.map((note) => (
          <li key={note} className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
            {note}
          </li>
        ))}
      </ul>
      {dialogOpen ? (
        <LinkBothWaysDialog machines={selected} onClose={() => setDialogOpen(false)} now={now} />
      ) : null}
    </SettingsSection>
  );
}

function LinkMap({
  nodes,
  edges,
  machineById,
  selectedIds,
  focusedEdgeKey,
  onFocusEdge,
}: {
  readonly nodes: ReadonlyArray<LinkGraphNode>;
  readonly edges: ReadonlyArray<LinkGraphEdge>;
  readonly machineById: ReadonlyMap<EnvironmentId, MachineState>;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly focusedEdgeKey: string | null;
  readonly onFocusEdge: (key: string | null) => void;
}) {
  const markerId = useId();
  const points = layoutMapNodes(nodes.length);
  const pointById = new Map(nodes.map((node, index) => [node.environmentId, points[index]!]));
  return (
    // The list below carries the same links for narrow windows and screen readers.
    <div className="px-3 py-3 max-sm:hidden sm:px-4">
      <svg
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        className="mx-auto block h-auto w-full max-w-2xl"
        role="group"
        aria-label="Link map"
      >
        <defs>
          {TONES.map((tone) => (
            <marker
              key={tone}
              id={`${markerId}-${tone}`}
              viewBox="0 0 10 10"
              refX="0"
              refY="5"
              markerUnits="userSpaceOnUse"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0,0 L10,5 L0,10 z" className={ARROW_FILL[tone]} />
            </marker>
          ))}
        </defs>
        {edges.map((edge) => {
          const from = pointById.get(edge.source.environmentId)!;
          const to = pointById.get(edge.target.environmentId)!;
          const segment = mapEdgeSegment(from, to, { parallel: edge.parallel });
          const focused = edge.key === focusedEdgeKey;
          const label = edgeDescription(edge);
          return (
            <g
              key={edge.key}
              role="button"
              tabIndex={0}
              aria-label={label}
              aria-pressed={focused}
              className="group cursor-pointer outline-none"
              onClick={() => onFocusEdge(focused ? null : edge.key)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onFocusEdge(focused ? null : edge.key);
              }}
            >
              <title>{label}</title>
              <line {...segment} className="stroke-transparent" strokeWidth={12} />
              <line
                {...segment}
                className={cn(
                  EDGE_STROKE[edge.view.tone],
                  "group-focus-visible:stroke-ring",
                  focused && "stroke-primary",
                )}
                strokeWidth={focused ? 2.5 : 1.5}
                strokeDasharray={DASHED_TONES.has(edge.view.tone) ? "5 4" : undefined}
                markerEnd={`url(#${markerId}-${edge.view.tone})`}
              />
            </g>
          );
        })}
        {nodes.map((node) => {
          const point = pointById.get(node.environmentId)!;
          const machine = machineById.get(node.environmentId);
          const note = nodeNote(node, machine);
          const selected = selectedIds.has(node.environmentId);
          const muted = machine === undefined || !machine.connected;
          const off = machine?.peerLinks === "off" || machine?.peerLinks === "unsupported";
          return (
            <g key={node.environmentId} aria-hidden className={cn(muted && "opacity-60")}>
              <title>{note ? `${node.label}, ${note}` : node.label}</title>
              <circle
                cx={point.x}
                cy={point.y}
                r={MAP_NODE_RADIUS}
                className={cn("fill-background", selected ? "stroke-primary" : "stroke-border")}
                strokeWidth={selected ? 2.5 : 1.5}
                strokeDasharray={off || !node.saved ? "4 3" : undefined}
              />
              <EnvironmentMachineIcon
                kind={resolveEnvironmentMachineKind(machine?.environment.serverConfig ?? null)}
                x={point.x - 8}
                y={point.y - 8}
                width={16}
                height={16}
                className="text-muted-foreground"
              />
              <text
                x={point.x}
                y={point.y + MAP_LABEL_OFFSET}
                textAnchor="middle"
                className="fill-foreground text-xs font-medium"
              >
                {mapNodeLabel(node.label)}
              </text>
              {note ? (
                <text
                  x={point.x}
                  y={point.y + MAP_SUBLABEL_OFFSET}
                  textAnchor="middle"
                  className="fill-muted-foreground text-3xs"
                >
                  {note}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function LinkRow({
  edge,
  highlighted,
  canUnlink,
}: {
  readonly edge: LinkGraphEdge;
  readonly highlighted: boolean;
  readonly canUnlink: boolean;
}) {
  const unlink = useAtomCommand(peerLinkEnvironment.unlink, { label: "unlink environment" });
  const [busy, setBusy] = useState(false);
  const { source, target, link, view } = edge;
  const remove = async () => {
    const confirmed = await (requestConfirmDialog(
      `Remove the link from ${source.label} to ${target.label}? Agents on ${source.label} stop working on ${target.label}. Revoke "T3 Code · …" in ${target.label}'s Sharing & access to end the session there too.`,
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    const result = await unlink({
      environmentId: source.environmentId,
      input: { environmentId: target.environmentId },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not remove the link",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <li
      className={cn("flex items-center gap-3 px-3 py-2.5 sm:px-4", highlighted && "bg-accent/60")}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {source.label} <span aria-hidden>→</span>
          <span className="sr-only">to</span> {target.label}
        </p>
        <p
          className={cn(
            "truncate text-xs text-muted-foreground",
            view.tone === "broken" && "text-destructive",
          )}
        >
          {accessConfig[link.access].label} · {view.fenced ? "Fenced" : "Not fenced"} ·{" "}
          {view.status}
        </p>
      </div>
      {canUnlink ? (
        <Button
          size="xs"
          variant="destructive-outline"
          disabled={busy}
          onClick={() => void remove()}
        >
          {busy ? "Removing…" : "Remove"}
        </Button>
      ) : null}
    </li>
  );
}
