import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { ConnectionStatusDot, connectionPhaseDotClassName } from "../ConnectionStatusDot";
import { EnvironmentRow, useEnvironmentTransportLabel } from "../settings/EnvironmentRow";
import { SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { machineUpdateVersion, type MachineUpdateRow } from "./machineUpdates.logic";
import { MoveAllThreadsAction } from "./MoveAllThreadsDialog";
import { UpdateMachinesDialog } from "./UpdateMachinesDialog";
import type { MachineState } from "./useMachines";
import { useMachineUpdatePlan } from "./useMachineUpdates";

export function MachineListSection({
  isReady,
  machines,
  selectedIds,
  onSelectedChange,
}: {
  readonly isReady: boolean;
  readonly machines: ReadonlyArray<MachineState>;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly onSelectedChange: (environmentId: EnvironmentId, selected: boolean) => void;
}) {
  const { rows } = useMachineUpdatePlan(machines);
  const [updating, setUpdating] = useState(false);
  return (
    <SettingsSection
      title="Machines"
      headerAction={
        machines.length > 0 ? (
          <Button size="xs" variant="outline" onClick={() => setUpdating(true)}>
            Update machines…
          </Button>
        ) : null
      }
    >
      {updating ? (
        <UpdateMachinesDialog machines={machines} onClose={() => setUpdating(false)} />
      ) : null}
      {machines.length === 0 ? (
        <p className="px-3 py-2.5 text-sm text-muted-foreground sm:px-4" role="status">
          {isReady ? (
            <>
              No machines yet. Add one in{" "}
              <Link to="/settings/connections" className="underline underline-offset-2">
                Settings → Connections
              </Link>
              .
            </>
          ) : (
            "Loading machines…"
          )}
        </p>
      ) : (
        machines.map((machine) => (
          <MachineRow
            key={machine.environmentId}
            machine={machine}
            update={rows.find((row) => row.environmentId === machine.environmentId)}
            selected={selectedIds.has(machine.environmentId)}
            onSelectedChange={(selected) => onSelectedChange(machine.environmentId, selected)}
          />
        ))
      )}
    </SettingsSection>
  );
}

function MachineRow({
  machine,
  update,
  selected,
  onSelectedChange,
}: {
  readonly machine: MachineState;
  readonly update: MachineUpdateRow | undefined;
  readonly selected: boolean;
  readonly onSelectedChange: (selected: boolean) => void;
}) {
  const { environment, facts } = machine;
  const transport = useEnvironmentTransportLabel(environment);
  const updateVersion = machineUpdateVersion(update);
  const status = environment.entry.enabled
    ? connectionStatusTitle(environment.connection)
    : "Switched off";
  return (
    <EnvironmentRow
      kind={resolveEnvironmentMachineKind(environment.serverConfig)}
      label={machine.label}
      dimmed={!machine.connected}
      subtitle={`${transport} · ${status}`}
      below={
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {machine.isThisComputer ? <Badge variant="secondary">This computer</Badge> : null}
          {facts.platform ? <span>{facts.platform}</span> : null}
          {facts.serverVersion ? <span>v{facts.serverVersion}</span> : null}
          {updateVersion !== null ? <Badge variant="info">Update to v{updateVersion}</Badge> : null}
          {facts.machineTransfers === null ? null : facts.machineTransfers ? (
            <Badge variant="info">Machine transfers</Badge>
          ) : (
            <Badge variant="outline">Stock server</Badge>
          )}
          {facts.peerLinks === "on" ? (
            <Badge variant="success">Links on</Badge>
          ) : facts.peerLinks === "off" ? (
            <>
              <Badge variant="warning">Links off</Badge>
              <TurnOnLinksAction machine={machine} />
            </>
          ) : facts.peerLinks === "unsupported" ? (
            <Badge variant="outline">No linking</Badge>
          ) : null}
          <MoveAllThreadsAction machine={machine} />
        </div>
      }
    >
      <ConnectionStatusDot
        dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
        tooltipText={status}
      />
      <Checkbox
        checked={selected}
        onCheckedChange={(checked) => onSelectedChange(checked === true)}
        aria-label={`Select ${machine.label}`}
      />
    </EnvironmentRow>
  );
}

/** Turns the Linked environments beta on where this session may change settings, else points there. */
export function TurnOnLinksAction({ machine }: { readonly machine: MachineState }) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "turn on linked environments",
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  if (!machine.connected) return null;
  if (!machine.canWriteSettings) {
    return (
      <Button
        size="xs"
        variant="link"
        render={<Link to="/settings/labs" search={{ machine: machine.environmentId }} />}
      >
        Turn on in Labs
      </Button>
    );
  }
  const turnOn = async () => {
    setBusy(true);
    const result = await updateSettings({
      environmentId: machine.environmentId,
      input: { patch: { linkedEnvironmentsEnabled: true } },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not turn on links on ${machine.label}`,
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <Button size="xs" variant="outline" disabled={busy} onClick={() => void turnOn()}>
      {busy ? "Turning on…" : "Turn on"}
    </Button>
  );
}
