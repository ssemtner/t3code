import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { useNavigate } from "@tanstack/react-router";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useProjects, useThreadShellsForProjectRefs } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  assistantProjectsOf,
  type MachineAssistantTarget,
  selectAssistantTargets,
} from "./MachinesAssistant.logic";
import type { MachineState } from "./useMachines";

export function MachinesAssistantButton({
  machines,
}: {
  readonly machines: ReadonlyArray<MachineState>;
}) {
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const projects = useProjects();
  const connectedIds = new Set(
    machines.filter((machine) => machine.connected).map((machine) => machine.environmentId),
  );
  const assistantProjects = assistantProjectsOf(projects, connectedIds);
  const shells = useThreadShellsForProjectRefs(
    assistantProjects.map((project) => scopeProjectRef(project.environmentId, project.id)),
  );
  const targets = selectAssistantTargets(
    assistantProjects,
    shells.map((shell) => ({
      environmentId: shell.environmentId,
      id: shell.id,
      projectId: shell.projectId,
      activityAt: resolveThreadActivityTimestamp(shell) ?? shell.updatedAt,
      archivedAt: shell.archivedAt,
    })),
    connectedIds,
  );

  if (targets.length === 0) return null;

  const open = (target: MachineAssistantTarget) => {
    if (target.threadId !== null) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(target.environmentId, target.threadId)),
      });
      return;
    }
    void handleNewThread(scopeProjectRef(target.environmentId, target.projectId));
  };

  const [only] = targets;
  if (targets.length === 1 && only) {
    return (
      <Button variant="outline" size="sm" onClick={() => open(only)}>
        Assistant
      </Button>
    );
  }

  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" size="sm" />}>Assistant</MenuTrigger>
      <MenuPopup align="end">
        {targets.map((target) => (
          <MenuItem key={target.environmentId} onClick={() => open(target)}>
            {machines.find((machine) => machine.environmentId === target.environmentId)?.label ??
              target.environmentId}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
