import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

const ASSISTANT_ROOT_SUFFIX = "/machines/assistant";

export function isMachineAssistantRoot(workspaceRoot: string): boolean {
  const normalized = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.endsWith(ASSISTANT_ROOT_SUFFIX);
}

export interface AssistantProjectInput {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly workspaceRoot: string;
  readonly archivedAt?: string | null | undefined;
}

export interface AssistantThreadInput {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly activityAt: string;
  readonly archivedAt: string | null;
}

export interface MachineAssistantTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
}

export function assistantProjectsOf<P extends AssistantProjectInput>(
  projects: ReadonlyArray<P>,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
): ReadonlyArray<P> {
  return projects.filter(
    (project) =>
      connectedEnvironmentIds.has(project.environmentId) &&
      !project.archivedAt &&
      isMachineAssistantRoot(project.workspaceRoot),
  );
}

export function selectAssistantTargets(
  projects: ReadonlyArray<AssistantProjectInput>,
  threads: ReadonlyArray<AssistantThreadInput>,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
): ReadonlyArray<MachineAssistantTarget> {
  const targets = new Map<EnvironmentId, MachineAssistantTarget>();
  for (const project of assistantProjectsOf(projects, connectedEnvironmentIds)) {
    if (targets.has(project.environmentId)) continue;
    let latest: AssistantThreadInput | null = null;
    let latestMs = Number.NEGATIVE_INFINITY;
    for (const thread of threads) {
      if (
        thread.environmentId !== project.environmentId ||
        thread.projectId !== project.id ||
        thread.archivedAt
      ) {
        continue;
      }
      const ms = Date.parse(thread.activityAt);
      const comparable = Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
      if (latest === null || comparable > latestMs) {
        latest = thread;
        latestMs = comparable;
      }
    }
    targets.set(project.environmentId, {
      environmentId: project.environmentId,
      projectId: project.id,
      threadId: latest?.id ?? null,
    });
  }
  return [...targets.values()];
}
