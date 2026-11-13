import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import type {
  EnvironmentId,
  ExecutionEnvironmentPlatform,
  PeerLinkSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

/** Whether a machine offers links: its server supports them and the Linked environments beta is on. */
export type PeerLinkSupport = "unknown" | "unsupported" | "off" | "on";

export interface MachineServerFacts {
  readonly platform: string | null;
  readonly serverVersion: string | null;
  /** Null until the server reports its config; absent on stock servers. */
  readonly machineTransfers: boolean | null;
  readonly peerLinks: PeerLinkSupport;
  /** Another machine links to this one only when it holds a linked agent to its limits. */
  readonly acceptsLinks: boolean;
}

const OS_LABELS = { darwin: "macOS", linux: "Linux", windows: "Windows", unknown: null } as const;

function platformLabel(platform: ExecutionEnvironmentPlatform): string | null {
  const os = OS_LABELS[platform.os];
  const arch = platform.arch === "other" ? null : platform.arch;
  return os === null ? arch : arch === null ? os : `${os} ${arch}`;
}

export function machineServerFacts(
  config: Pick<EnvironmentServerConfig, "environment" | "settings"> | null,
): MachineServerFacts {
  if (config === null) {
    return {
      platform: null,
      serverVersion: null,
      machineTransfers: null,
      peerLinks: "unknown",
      acceptsLinks: false,
    };
  }
  const { capabilities, platform, serverVersion } = config.environment;
  return {
    platform: platformLabel(platform),
    serverVersion,
    machineTransfers: capabilities.machineTransfers === true,
    peerLinks:
      capabilities.peerLinks !== true
        ? "unsupported"
        : config.settings.linkedEnvironmentsEnabled
          ? "on"
          : "off",
    acceptsLinks: capabilities.linkFence === true && capabilities.mcpModeLimitHeader === true,
  };
}

/** One machine's `peerLinks.list`, as far as this client got with it. */
export type PeerLinkListState =
  | { readonly kind: "unavailable" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly links: ReadonlyArray<PeerLinkSummary> };

export type PeerLinkTone = "live" | "expiring" | "broken" | "unreachable";

export interface PeerLinkView {
  readonly tone: PeerLinkTone;
  /** A link works only while it is reachable and unexpired; anything else may be linked again. */
  readonly live: boolean;
  readonly expired: boolean;
  /** Made after link fencing. The server lists an unfenced link as expiring when it was made. */
  readonly fenced: boolean;
  readonly status: string;
}

const EXPIRING_DAYS = 5;

export function peerLinkView(link: PeerLinkSummary, now: DateTime.Utc): PeerLinkView {
  const fenced = !DateTime.Equivalence(link.expiresAt, link.linkedAt);
  const health = peerLinkHealth(link, now);
  if (health.kind === "expired") {
    return {
      tone: "broken",
      live: false,
      expired: true,
      fenced,
      status: fenced ? "Expired" : "Made before link limits",
    };
  }
  if (health.kind === "unreachable") {
    return {
      tone: "unreachable",
      live: false,
      expired: false,
      fenced,
      status: health.detail ?? "Not answering",
    };
  }
  if (health.kind === "failing") {
    return { tone: "broken", live: false, expired: false, fenced, status: health.detail };
  }
  const days = Math.max(1, Math.ceil(Duration.toDays(DateTime.distance(now, link.expiresAt))));
  return {
    tone: days <= EXPIRING_DAYS ? "expiring" : "live",
    live: true,
    expired: false,
    fenced,
    status: `Expires in ${days} ${days === 1 ? "day" : "days"}`,
  };
}

export interface LinkGraphNode {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Saved in this client. A link can lead to a machine this client does not know. */
  readonly saved: boolean;
}

export interface LinkGraphEdge {
  readonly key: string;
  readonly source: LinkGraphNode;
  readonly target: LinkGraphNode;
  readonly link: PeerLinkSummary;
  readonly view: PeerLinkView;
  /** The reverse link is drawn too. */
  readonly parallel: boolean;
}

/** Saved machines in catalog order, then machines only a link names, with every listed link. */
export function buildLinkGraph(
  machines: ReadonlyArray<Pick<LinkPlanMachine, "environmentId" | "label" | "links">>,
  now: DateTime.Utc,
): { readonly nodes: ReadonlyArray<LinkGraphNode>; readonly edges: ReadonlyArray<LinkGraphEdge> } {
  const nodes = new Map<EnvironmentId, LinkGraphNode>(
    machines.map((machine) => [
      machine.environmentId,
      { environmentId: machine.environmentId, label: machine.label, saved: true },
    ]),
  );
  const pairs = machines.flatMap((machine) =>
    machine.links.kind === "ready"
      ? machine.links.links.map((link) => ({ source: machine.environmentId, link }))
      : [],
  );
  for (const { link } of pairs) {
    if (!nodes.has(link.environmentId)) {
      nodes.set(link.environmentId, {
        environmentId: link.environmentId,
        label: link.label,
        saved: false,
      });
    }
  }
  const drawn = new Set(pairs.map(({ source, link }) => `${source}\n${link.environmentId}`));
  const edges = pairs.map(({ source, link }) => ({
    key: `${source}\n${link.environmentId}`,
    source: nodes.get(source)!,
    target: nodes.get(link.environmentId)!,
    link,
    view: peerLinkView(link, now),
    parallel: drawn.has(`${link.environmentId}\n${source}`),
  }));
  return { nodes: [...nodes.values()], edges };
}

export interface LinkPlanMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly peerLinks: PeerLinkSupport;
  readonly acceptsLinks: boolean;
  /** This client's session there may link from it and mint its pairing codes (`access:write`). */
  readonly canManageAccess: boolean;
  /** Addresses another machine can reach it at, most preferred first. */
  readonly urls: ReadonlyArray<string>;
  readonly links: PeerLinkListState;
}

interface PairEnd {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export type LinkPairPlan =
  | {
      readonly kind: "create";
      readonly source: PairEnd;
      readonly target: PairEnd;
      /** A link exists but does not work: expired, unfenced, failing or unreachable. */
      readonly renew: boolean;
      readonly urls: readonly [string, ...string[]];
    }
  | { readonly kind: "linked"; readonly source: PairEnd; readonly target: PairEnd }
  | {
      readonly kind: "blocked";
      readonly source: PairEnd;
      readonly target: PairEnd;
      readonly reason: string;
    };

export type LinkPairCreate = Extract<LinkPairPlan, { readonly kind: "create" }>;

const end = (machine: LinkPlanMachine): PairEnd => ({
  environmentId: machine.environmentId,
  label: machine.label,
});

function blockReason(source: LinkPlanMachine, target: LinkPlanMachine): string | null {
  for (const machine of [source, target]) {
    if (!machine.connected) return `${machine.label} is not connected.`;
  }
  for (const machine of [source, target]) {
    if (machine.peerLinks === "unknown") return `${machine.label} has not reported its settings.`;
    if (machine.peerLinks === "unsupported") {
      return `${machine.label} runs a version without linked environments.`;
    }
  }
  if (!target.acceptsLinks) {
    return `${target.label} runs a version that cannot keep a linked agent's limits.`;
  }
  for (const machine of [source, target]) {
    if (machine.peerLinks === "off") return `Linked environments is off on ${machine.label}.`;
  }
  if (!source.canManageAccess) return `No permission to manage access on ${source.label}.`;
  if (!target.canManageAccess) return `No permission to create pairing codes on ${target.label}.`;
  switch (source.links.kind) {
    case "loading":
      return `Loading ${source.label}'s links.`;
    case "failed":
      return `Could not read ${source.label}'s links: ${source.links.message}`;
    case "unavailable":
      return `No permission to read ${source.label}'s links.`;
    case "ready":
      return null;
  }
}

/**
 * Every ordered pair of `machines`, in selection order: a live link is left alone, and any
 * other pair is linked unless something this client can see would stop it.
 */
export function planLinkBothWays(
  machines: ReadonlyArray<LinkPlanMachine>,
  now: DateTime.Utc,
): ReadonlyArray<LinkPairPlan> {
  return machines.flatMap((source) =>
    machines.flatMap((target): ReadonlyArray<LinkPairPlan> => {
      if (source.environmentId === target.environmentId) return [];
      const existing =
        source.links.kind === "ready"
          ? source.links.links.find((link) => link.environmentId === target.environmentId)
          : undefined;
      if (existing !== undefined && peerLinkView(existing, now).live) {
        return [{ kind: "linked", source: end(source), target: end(target) }];
      }
      const blocked = (reason: string) => [
        { kind: "blocked", source: end(source), target: end(target), reason } as const,
      ];
      const reason = blockReason(source, target);
      if (reason !== null) return blocked(reason);
      const [url, ...alternates] = target.urls;
      if (url === undefined) {
        return blocked(`No address for ${target.label} that another machine can reach.`);
      }
      return [
        {
          kind: "create",
          source: end(source),
          target: end(target),
          renew: existing !== undefined,
          urls: [url, ...alternates],
        },
      ];
    }),
  );
}

/** Selected machines whose beta is off, which turning it on would unblock. */
export function machinesWithLinksOff<T extends LinkPlanMachine>(
  machines: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return machines.filter((machine) => machine.connected && machine.peerLinks === "off");
}

export type LinkPairOutcome =
  | { readonly ok: true; readonly pair: LinkPairCreate }
  | { readonly ok: false; readonly pair: LinkPairCreate; readonly message: string };

type StepResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

/**
 * Links each pair in turn: a pairing code minted on the target with this client's session there,
 * then handed to the source. A failure is reported and the next pair still runs.
 */
export async function runLinkPairs(
  pairs: ReadonlyArray<LinkPairCreate>,
  steps: {
    readonly mint: (pair: LinkPairCreate) => Promise<StepResult<string>>;
    readonly link: (pair: LinkPairCreate, pairingCode: string) => Promise<StepResult<unknown>>;
  },
  onOutcome: (outcome: LinkPairOutcome) => void,
): Promise<ReadonlyArray<LinkPairOutcome>> {
  const outcomes: Array<LinkPairOutcome> = [];
  for (const pair of pairs) {
    const code = await steps.mint(pair);
    const linked = code.ok ? await steps.link(pair, code.value) : code;
    const outcome: LinkPairOutcome = linked.ok
      ? { ok: true, pair }
      : { ok: false, pair, message: linked.message };
    outcomes.push(outcome);
    onOutcome(outcome);
  }
  return outcomes;
}

/** Failures whose message is written for the user and never echoes the request, so never the code. */
const USER_FACING_FAILURE_TAGS = new Set([
  "PeerLinkError",
  "PeerPairingCodeError",
  "EnvironmentAuthorizationError",
]);

export function linkFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not link. Try again.";
}

export const MAP_WIDTH = 640;
export const MAP_HEIGHT = 320;
export const MAP_NODE_RADIUS = 20;
const MAP_MARGIN_X = 96;
const MAP_MARGIN_TOP = 36;
const MAP_MARGIN_BOTTOM = 56;
/** Baselines of a node's name and its status line, below the node. */
export const MAP_LABEL_OFFSET = MAP_NODE_RADIUS + 14;
export const MAP_SUBLABEL_OFFSET = MAP_NODE_RADIUS + 27;
const EDGE_GAP = 4;
const ARROW_LENGTH = 7;
const PARALLEL_OFFSET = 5;

export interface MapPoint {
  readonly x: number;
  readonly y: number;
}

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Node centres for `count` machines, in order: one centred, two side by side, more on an
 * ellipse clockwise from the top. The same count always gives the same picture.
 */
export function layoutMapNodes(count: number): ReadonlyArray<MapPoint> {
  const cx = MAP_WIDTH / 2;
  const cy = (MAP_MARGIN_TOP + MAP_HEIGHT - MAP_MARGIN_BOTTOM) / 2;
  const rx = MAP_WIDTH / 2 - MAP_MARGIN_X;
  const ry = (MAP_HEIGHT - MAP_MARGIN_TOP - MAP_MARGIN_BOTTOM) / 2;
  if (count <= 0) return [];
  if (count === 1) return [{ x: cx, y: cy }];
  const start = count === 2 ? Math.PI : -Math.PI / 2;
  return Array.from({ length: count }, (_, index) => {
    const angle = start + (2 * Math.PI * index) / count;
    return { x: round(cx + rx * Math.cos(angle)), y: round(cy + ry * Math.sin(angle)) };
  });
}

/**
 * The line for a link from `from` to `to`, clear of both nodes and of the arrowhead. When the
 * reverse link exists too, each shifts to its own right so the two stay apart.
 */
export function mapEdgeSegment(
  from: MapPoint,
  to: MapPoint,
  options: { readonly parallel: boolean },
) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const shift = options.parallel ? PARALLEL_OFFSET : 0;
  const nx = -uy * shift;
  const ny = ux * shift;
  const startTrim = MAP_NODE_RADIUS + EDGE_GAP;
  const endTrim = MAP_NODE_RADIUS + EDGE_GAP + ARROW_LENGTH;
  return {
    x1: round(from.x + ux * startTrim + nx),
    y1: round(from.y + uy * startTrim + ny),
    x2: round(to.x - ux * endTrim + nx),
    y2: round(to.y - uy * endTrim + ny),
  };
}

const MAP_LABEL_MAX = 18;

export function mapNodeLabel(label: string): string {
  return label.length <= MAP_LABEL_MAX ? label : `${label.slice(0, MAP_LABEL_MAX - 1)}…`;
}
