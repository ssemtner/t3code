import { EnvironmentId, type ServerSelfUpdateCapability } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ServerUpdateOutcome, ServerUpdateTarget } from "../ServerUpdateAction";
import {
  defaultMachineUpdateSelection,
  type MachineUpdateInput,
  type MachineUpdateRunState,
  planMachineUpdates,
  runMachineUpdates,
  selectedMachineUpdates,
} from "./machineUpdates.logic";

const TARGET = "0.1.10-fork.42";

function machine(
  id: string,
  serverVersion: string,
  selfUpdate: ServerSelfUpdateCapability | undefined,
  overrides: Partial<MachineUpdateInput> = {},
): MachineUpdateInput {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    serverConfig: {
      environment: {
        environmentId: EnvironmentId.make(id),
        label: id,
        platform: { os: "linux", arch: "x64" },
        serverVersion,
        capabilities: {
          repositoryIdentity: true,
          ...(selfUpdate ? { serverSelfUpdate: selfUpdate } : {}),
        },
      },
      settings: { continueThreadsAfterServerUpdate: false },
    },
    connected: true,
    hostedByThisApp: false,
    canMaintain: true,
    updateState: { status: "idle" },
    isThisComputer: false,
    runningThreads: 0,
    ...overrides,
  };
}

describe("planMachineUpdates", () => {
  it("classifies each machine and puts this computer last", () => {
    const rows = planMachineUpdates(
      [
        machine("home", "0.1.10-fork.40", "boot-service", { isThisComputer: true }),
        machine("service", "0.1.10-fork.40", "boot-service"),
        machine("busy", "0.1.10-fork.40", "boot-service", { runningThreads: 2 }),
        machine("current", TARGET, "boot-service"),
        machine("source", "0.1.10-fork.40", undefined),
        machine("no-scope", "0.1.10-fork.40", "boot-service", { canMaintain: false }),
        machine("offline", TARGET, "boot-service", { connected: false }),
        machine("desktop", "0.1.10-fork.40", "desktop-managed", { hostedByThisApp: true }),
      ],
      TARGET,
    );

    expect(
      rows.map((row) => [
        row.label,
        row.kind,
        row.kind === "unavailable" ? row.reason : row.fromVersion,
      ]),
    ).toEqual([
      ["service", "update", "0.1.10-fork.40"],
      ["busy", "busy", "0.1.10-fork.40"],
      ["current", "current", TARGET],
      ["source", "unavailable", "needs a manual update"],
      ["no-scope", "unavailable", "no permission"],
      ["offline", "unavailable", "not connected"],
      ["desktop", "unavailable", "updates with this desktop app"],
      ["home", "update", "0.1.10-fork.40"],
    ]);
  });

  it("selects updatable machines by default but leaves busy ones for the user to tick", () => {
    const rows = planMachineUpdates(
      [
        machine("home", "0.1.10-fork.40", "boot-service", { isThisComputer: true }),
        machine("busy", "0.1.10-fork.40", "boot-service", { runningThreads: 1 }),
        machine("service", "0.1.10-fork.40", "boot-service"),
      ],
      TARGET,
    );
    const selection = defaultMachineUpdateSelection(rows);

    expect([...selection]).toEqual(["service", "home"]);
    expect(
      selectedMachineUpdates(rows, new Set([...selection, EnvironmentId.make("busy")])).map(
        (target) => target.environmentId,
      ),
    ).toEqual(["busy", "service", "home"]);
  });
});

describe("runMachineUpdates", () => {
  it("updates one machine at a time and carries on past a failure", async () => {
    const target = (id: string): ServerUpdateTarget => ({
      environmentId: EnvironmentId.make(id),
      serverLabel: id,
      selfUpdate: "boot-service",
      targetVersion: TARGET,
    });
    const outcomes: Record<string, ServerUpdateOutcome> = {
      a: { status: "failed", message: "Disk full." },
      b: { status: "skipped" },
      c: { status: "updated" },
    };
    const events: Array<[string, MachineUpdateRunState]> = [];
    let inFlight = 0;

    await runMachineUpdates(
      [target("a"), target("b"), target("c")],
      async ({ environmentId }) => {
        inFlight += 1;
        expect(inFlight).toBe(1);
        await Promise.resolve();
        inFlight -= 1;
        return outcomes[environmentId]!;
      },
      (environmentId, state) => events.push([environmentId, state]),
    );

    expect(events).toEqual([
      ["a", { status: "updating" }],
      ["a", { status: "failed", message: "Disk full." }],
      ["b", { status: "updating" }],
      [
        "b",
        {
          status: "failed",
          message:
            "Not started: another update is running there, or this session may not update it.",
        },
      ],
      ["c", { status: "updating" }],
      ["c", { status: "updated" }],
    ]);
  });
});
