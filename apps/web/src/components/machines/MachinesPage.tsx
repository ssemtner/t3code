import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { ScrollArea } from "../ui/scroll-area";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { LinkMapSection } from "./LinkMapSection";
import { MachineListSection } from "./MachineListSection";
import { MachinesAssistantButton } from "./MachinesAssistantButton";
import { MachinesConfigSection } from "./MachinesConfigSection";
import { MachinesReposSection } from "./MachinesReposSection";
import { useMachines } from "./useMachines";

/** The user's machines and what spans them. Each concern is one section below the header. */
export function MachinesPage() {
  const { isReady, machines } = useMachines();
  // Insertion order is selection order, which orders the pairs a link run creates.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<EnvironmentId>>(new Set());
  const selected = [...selectedIds].flatMap((environmentId) =>
    machines.filter((machine) => machine.environmentId === environmentId),
  );
  const setSelected = (environmentId: EnvironmentId, next: boolean) =>
    setSelectedIds((current) => {
      const updated = new Set(current);
      if (next) updated.add(environmentId);
      else updated.delete(environmentId);
      return updated;
    });

  return (
    <AppRouteModal label="Machines">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b ps-5 pe-2">
          <WorkspaceBreadcrumb ariaLabel="Machines breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1>Machines</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="ms-auto flex shrink-0 items-center gap-2">
            <MachinesAssistantButton machines={machines} />
            <AppRouteModalClose />
          </div>
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            <MachineListSection
              isReady={isReady}
              machines={machines}
              selectedIds={selectedIds}
              onSelectedChange={setSelected}
            />
            {machines.length > 0 ? (
              <LinkMapSection machines={machines} selected={selected} />
            ) : null}
            <MachinesReposSection machines={machines} />
            <MachinesConfigSection machines={machines} />
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </AppRouteModal>
  );
}
