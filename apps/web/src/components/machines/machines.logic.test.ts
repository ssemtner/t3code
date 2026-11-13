import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildLinkGraph,
  type LinkPairCreate,
  type LinkPlanMachine,
  layoutMapNodes,
  linkFailureMessage,
  machineServerFacts,
  mapEdgeSegment,
  MAP_HEIGHT,
  MAP_NODE_RADIUS,
  MAP_SUBLABEL_OFFSET,
  MAP_WIDTH,
  peerLinkView,
  planLinkBothWays,
  runLinkPairs,
} from "./machines.logic";

const now = DateTime.makeUnsafe("2026-11-13T12:00:00.000Z");
const laptop = EnvironmentId.make("env-laptop");
const desk = EnvironmentId.make("env-desk");
const box = EnvironmentId.make("env-box");

const link = (
  environmentId: EnvironmentId,
  overrides: Partial<PeerLinkSummary> = {},
): PeerLinkSummary => ({
  environmentId,
  label: environmentId,
  urls: ["https://peer.example.ts.net"],
  access: "approval-required",
  linkedAt: DateTime.makeUnsafe("2026-11-01T12:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2026-12-01T12:00:00.000Z"),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
  ...overrides,
});

const machine = (
  environmentId: EnvironmentId,
  overrides: Partial<LinkPlanMachine> = {},
): LinkPlanMachine => ({
  environmentId,
  label: environmentId.replace("env-", ""),
  connected: true,
  peerLinks: "on",
  acceptsLinks: true,
  canManageAccess: true,
  urls: [`https://${environmentId}.example.ts.net`],
  links: { kind: "ready", links: [] },
  ...overrides,
});

const summarize = (plans: ReturnType<typeof planLinkBothWays>) =>
  plans.map((plan) =>
    [
      `${plan.source.label}->${plan.target.label}`,
      plan.kind,
      plan.kind === "blocked" ? plan.reason : plan.kind === "create" && plan.renew ? "renew" : "",
    ]
      .filter(Boolean)
      .join(" "),
  );

describe("planLinkBothWays", () => {
  it("creates every missing ordered pair and leaves live links alone", () => {
    const plans = planLinkBothWays(
      [
        machine(laptop, { links: { kind: "ready", links: [link(desk)] } }),
        machine(desk),
        machine(box),
      ],
      now,
    );
    expect(summarize(plans)).toEqual([
      "laptop->desk linked",
      "laptop->box create",
      "desk->laptop create",
      "desk->box create",
      "box->laptop create",
      "box->desk create",
    ]);
  });

  it("renews a link that exists but does not work", () => {
    const plans = planLinkBothWays(
      [
        machine(laptop, {
          links: {
            kind: "ready",
            links: [
              link(desk, { status: "expired", expiresAt: DateTime.makeUnsafe("2026-11-10") }),
              link(box, { lastError: "The peer revoked this link." }),
            ],
          },
        }),
        machine(desk, { links: { kind: "ready", links: [link(laptop)] } }),
        machine(box, { links: { kind: "ready", links: [link(laptop), link(desk)] } }),
      ],
      now,
    );
    expect(summarize(plans)).toEqual([
      "laptop->desk create renew",
      "laptop->box create renew",
      "desk->laptop linked",
      "desk->box create",
      "box->laptop linked",
      "box->desk linked",
    ]);
  });

  it.each([
    {
      name: "a machine is not connected",
      desk: { connected: false },
      reason: "desk is not connected.",
    },
    {
      name: "a server predates linking",
      desk: { peerLinks: "unsupported" as const },
      reason: "desk runs a version without linked environments.",
    },
    {
      name: "the target cannot fence a linked agent",
      desk: { acceptsLinks: false },
      reason: "desk runs a version that cannot keep a linked agent's limits.",
    },
    {
      name: "the beta is off on a machine",
      desk: { peerLinks: "off" as const },
      reason: "Linked environments is off on desk.",
    },
    {
      name: "the client may not mint a code on the target",
      desk: { canManageAccess: false },
      reason: "No permission to create pairing codes on desk.",
    },
    {
      name: "no other machine can reach the target",
      desk: { urls: [] },
      reason: "No address for desk that another machine can reach.",
    },
  ])("blocks laptop->desk when $name", ({ desk: overrides, reason }) => {
    const [first] = planLinkBothWays([machine(laptop), machine(desk, overrides)], now);
    expect(first).toMatchObject({ kind: "blocked", reason });
  });

  it("blocks a pair until the source's links are known", () => {
    const plans = planLinkBothWays(
      [
        machine(laptop, { links: { kind: "loading" } }),
        machine(desk, { links: { kind: "failed", message: "Timed out." } }),
      ],
      now,
    );
    expect(summarize(plans)).toEqual([
      "laptop->desk blocked Loading laptop's links.",
      "desk->laptop blocked Could not read desk's links: Timed out.",
    ]);
  });

  it("blocks the source side when this client may not link from it", () => {
    const plans = planLinkBothWays(
      [machine(laptop, { canManageAccess: false }), machine(desk)],
      now,
    );
    expect(summarize(plans)).toEqual([
      "laptop->desk blocked No permission to manage access on laptop.",
      "desk->laptop blocked No permission to create pairing codes on laptop.",
    ]);
  });
});

describe("peerLinkView", () => {
  it.each([
    { name: "a healthy link", overrides: {}, tone: "live", status: "Expires in 18 days" },
    {
      name: "a link about to expire",
      overrides: { expiresAt: DateTime.makeUnsafe("2026-11-15T00:00:00.000Z") },
      tone: "expiring",
      status: "Expires in 2 days",
    },
    {
      name: "an expired link",
      overrides: { status: "expired" as const, expiresAt: DateTime.makeUnsafe("2026-11-10") },
      tone: "broken",
      status: "Expired",
    },
    {
      name: "a link from before fencing, which the server lists as expiring when made",
      overrides: {
        status: "expired" as const,
        expiresAt: DateTime.makeUnsafe("2026-11-01T12:00:00.000Z"),
      },
      tone: "broken",
      status: "Made before link limits",
      fenced: false,
    },
    {
      name: "an unreachable peer",
      overrides: { status: "unreachable" as const, lastError: null },
      tone: "unreachable",
      status: "Not answering",
    },
  ])("describes $name", ({ overrides, tone, status, fenced = true }) => {
    expect(peerLinkView(link(desk, overrides), now)).toMatchObject({ tone, status, fenced });
  });
});

describe("machineServerFacts", () => {
  const config = (capabilities: Record<string, boolean>, linkedEnvironmentsEnabled: boolean) =>
    ({
      environment: {
        environmentId: laptop,
        label: "Laptop",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.1.9",
        capabilities,
      },
      settings: { linkedEnvironmentsEnabled },
    }) as unknown as Parameters<typeof machineServerFacts>[0];

  it("treats a server without the fork capability as stock", () => {
    expect(machineServerFacts(config({ peerLinks: true }, false))).toMatchObject({
      platform: "macOS arm64",
      machineTransfers: false,
      peerLinks: "off",
      acceptsLinks: false,
    });
  });

  it("reads machine transfers, the beta, and fencing", () => {
    expect(
      machineServerFacts(
        config(
          { machineTransfers: true, peerLinks: true, linkFence: true, mcpModeLimitHeader: true },
          true,
        ),
      ),
    ).toMatchObject({ machineTransfers: true, peerLinks: "on", acceptsLinks: true });
  });
});

describe("runLinkPairs", () => {
  const pair = (source: EnvironmentId, target: EnvironmentId): LinkPairCreate => ({
    kind: "create",
    source: { environmentId: source, label: source },
    target: { environmentId: target, label: target },
    renew: false,
    urls: [`https://${target}.example.ts.net`],
  });

  it("runs pairs one at a time and keeps going after a failure", async () => {
    const calls: Array<string> = [];
    const reported: Array<string> = [];
    const outcomes = await runLinkPairs(
      [pair(laptop, desk), pair(desk, laptop), pair(box, laptop)],
      {
        mint: async ({ target }) => {
          calls.push(`mint ${target.environmentId}`);
          return target.environmentId === desk
            ? { ok: false, message: "Your session there cannot create pairing codes." }
            : { ok: true, value: `code-${target.environmentId}` };
        },
        link: async ({ source }, code) => {
          calls.push(`link ${source.environmentId} ${code}`);
          return source.environmentId === box
            ? { ok: false, message: "env-laptop did not answer." }
            : { ok: true, value: undefined };
        },
      },
      (outcome) => reported.push(`${outcome.pair.source.environmentId}:${outcome.ok}`),
    );
    expect(calls).toEqual([
      "mint env-desk",
      "mint env-laptop",
      "link env-desk code-env-laptop",
      "mint env-laptop",
      "link env-box code-env-laptop",
    ]);
    expect(reported).toEqual(["env-laptop:false", "env-desk:true", "env-box:false"]);
    expect(outcomes.map((outcome) => (outcome.ok ? "ok" : outcome.message))).toEqual([
      "Your session there cannot create pairing codes.",
      "ok",
      "env-laptop did not answer.",
    ]);
  });
});

describe("linkFailureMessage", () => {
  it("passes a link error through but never an unknown failure, which could echo the code", () => {
    expect(linkFailureMessage({ _tag: "PeerLinkError", message: "desk did not answer." })).toBe(
      "desk did not answer.",
    );
    expect(
      linkFailureMessage({ _tag: "RpcClientError", message: "bad payload pairingCode=ABC" }),
    ).toBe("Could not link. Try again.");
  });
});

describe("buildLinkGraph", () => {
  it("adds machines only a link names and pairs links that run both ways", () => {
    const { nodes, edges } = buildLinkGraph(
      [
        {
          environmentId: laptop,
          label: "Laptop",
          links: { kind: "ready", links: [link(desk), link(box, { label: "VPS" })] },
        },
        { environmentId: desk, label: "Desk", links: { kind: "ready", links: [link(laptop)] } },
      ],
      now,
    );
    expect(nodes.map((node) => `${node.label}:${node.saved}`)).toEqual([
      "Laptop:true",
      "Desk:true",
      "VPS:false",
    ]);
    expect(
      edges.map((edge) => `${edge.source.label}->${edge.target.label}:${edge.parallel}`),
    ).toEqual(["Laptop->Desk:true", "Laptop->VPS:false", "Desk->Laptop:true"]);
  });
});

describe("layoutMapNodes", () => {
  it.each([1, 2, 3, 6])("keeps %i nodes and their labels inside the map", (count) => {
    const nodes = layoutMapNodes(count);
    expect(nodes).toHaveLength(count);
    expect(layoutMapNodes(count)).toEqual(nodes);
    for (const node of nodes) {
      expect(node.x - MAP_NODE_RADIUS).toBeGreaterThanOrEqual(0);
      expect(node.x + MAP_NODE_RADIUS).toBeLessThanOrEqual(MAP_WIDTH);
      expect(node.y - MAP_NODE_RADIUS).toBeGreaterThanOrEqual(0);
      expect(node.y + MAP_SUBLABEL_OFFSET + 4).toBeLessThanOrEqual(MAP_HEIGHT);
    }
    expect(new Set(nodes.map((node) => `${node.x},${node.y}`)).size).toBe(count);
  });

  it("puts two machines side by side", () => {
    const [left, right] = layoutMapNodes(2);
    expect(left!.y).toBe(right!.y);
    expect(left!.x).toBeLessThan(right!.x);
  });
});

describe("mapEdgeSegment", () => {
  it("keeps a link and its reverse apart", () => {
    const a = { x: 100, y: 100 };
    const b = { x: 300, y: 100 };
    const forward = mapEdgeSegment(a, b, { parallel: true });
    const back = mapEdgeSegment(b, a, { parallel: true });
    expect(forward.y1).not.toBe(back.y1);
    expect(forward.x1).toBeGreaterThan(a.x + MAP_NODE_RADIUS);
    expect(forward.x2).toBeLessThan(b.x - MAP_NODE_RADIUS);
  });
});
