import { useAtomValue } from "@effect/atom-react";
import { linkableMachines } from "@t3tools/client-runtime/link-request";
import {
  AuthAccessReadScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { environmentAtomList, environmentIdsKey } from "~/state/environmentAtomList";
import {
  type EnvironmentPresentation,
  useEnvironments,
  useRelayEnvironmentDiscovery,
} from "~/state/environments";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { formatEnvironmentQueryError } from "~/state/query";
import { useEnvironmentsWithScope } from "~/state/session";
import {
  type LinkPlanMachine,
  machineServerFacts,
  type MachineServerFacts,
  type PeerLinkListState,
} from "./machines.logic";

const peerLinkListsAtom = environmentAtomList("web-machines-peer-links", (environmentId) =>
  peerLinkEnvironment.list({ environmentId, input: {} }),
);
const linkPermissionsAtom = environmentAtomList(
  "web-machines-link-permissions",
  peerLinkEnvironment.link.permissionAtom,
);
const unlinkPermissionsAtom = environmentAtomList(
  "web-machines-unlink-permissions",
  peerLinkEnvironment.unlink.permissionAtom,
);

export interface MachineState extends LinkPlanMachine {
  readonly environment: EnvironmentPresentation;
  readonly facts: MachineServerFacts;
  readonly isThisComputer: boolean;
  readonly canUnlink: boolean;
  readonly canWriteSettings: boolean;
}

/** Every saved environment with what this client knows about it and its links. */
export function useMachines(): {
  readonly isReady: boolean;
  readonly machines: ReadonlyArray<MachineState>;
} {
  const { environments, isReady } = useEnvironments();
  const discovery = useRelayEnvironmentDiscovery();
  const linkHosts = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.peerLinks === true,
  );
  const readable = useEnvironmentsWithScope(linkHosts, AuthAccessReadScope);
  const listIds = linkHosts.flatMap((environment) =>
    readable.has(environment.environmentId) ? [environment.environmentId] : [],
  );
  const lists = useAtomValue(peerLinkListsAtom(environmentIdsKey(listIds)));
  const allKey = environmentIdsKey(environments.map(({ environmentId }) => environmentId));
  const linkPermissions = useAtomValue(linkPermissionsAtom(allKey));
  const unlinkPermissions = useAtomValue(unlinkPermissionsAtom(allKey));
  const settingsWritable = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);

  // A machine's addresses do not depend on which machine links to it; the catalog
  // helper leaves out the source, so ask until every machine has been a target once.
  const urlsById = new Map<EnvironmentId, ReadonlyArray<string>>();
  for (const source of environments) {
    if (urlsById.size === environments.length) break;
    for (const candidate of linkableMachines({
      environments,
      threadEnvironmentId: source.environmentId,
      links: [],
      connect: discovery.environments,
    })) {
      if (!urlsById.has(candidate.environmentId)) {
        urlsById.set(candidate.environmentId, candidate.urls);
      }
    }
  }

  const machines = environments.map((environment, index): MachineState => {
    const facts = machineServerFacts(environment.serverConfig);
    const listIndex = listIds.indexOf(environment.environmentId);
    const query = listIndex < 0 ? null : lists[listIndex]!;
    const links: PeerLinkListState =
      query === null
        ? { kind: "unavailable" }
        : query._tag === "Failure"
          ? { kind: "failed", message: formatEnvironmentQueryError(query.cause) }
          : query._tag === "Success"
            ? { kind: "ready", links: query.value.links }
            : { kind: "loading" };
    return {
      environmentId: environment.environmentId,
      label: environment.label,
      connected: environment.connection.phase === "connected" && environment.serverConfig !== null,
      peerLinks: facts.peerLinks,
      acceptsLinks: facts.acceptsLinks,
      canManageAccess: linkPermissions[index] === true,
      urls: urlsById.get(environment.environmentId) ?? [],
      links,
      environment,
      facts,
      isThisComputer: environment.entry.target._tag === "PrimaryConnectionTarget",
      canUnlink: unlinkPermissions[index] === true,
      canWriteSettings: settingsWritable.has(environment.environmentId),
    };
  });
  return { isReady, machines };
}
