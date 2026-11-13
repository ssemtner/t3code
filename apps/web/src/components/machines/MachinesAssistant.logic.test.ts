import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type AssistantProjectInput,
  type AssistantThreadInput,
  isMachineAssistantRoot,
  selectAssistantTargets,
} from "./MachinesAssistant.logic";

const laptop = EnvironmentId.make("env-laptop");
const desk = EnvironmentId.make("env-desk");
const project = (
  environmentId: EnvironmentId,
  id: string,
  workspaceRoot = "/home/me/.t3/machines/assistant",
  archivedAt: string | null = null,
): AssistantProjectInput => ({
  environmentId,
  id: ProjectId.make(id),
  workspaceRoot,
  archivedAt,
});
const thread = (
  environmentId: EnvironmentId,
  id: string,
  projectId: string,
  activityAt: string,
  archivedAt: string | null = null,
): AssistantThreadInput => ({
  environmentId,
  id: ThreadId.make(id),
  projectId: ProjectId.make(projectId),
  activityAt,
  archivedAt,
});

describe("isMachineAssistantRoot", () => {
  it.each([
    ["/home/me/.t3/machines/assistant", true],
    ["/home/me/.t3/machines/assistant/", true],
    ["C:\\Users\\me\\.t3\\machines\\assistant", true],
    ["C:\\Users\\me\\.t3\\machines\\assistant\\", true],
    ["/home/me/machines/assistant-notes", false],
    ["/home/me/machines", false],
    ["/home/me/other/assistant", false],
  ])("%s -> %s", (root, expected) => {
    expect(isMachineAssistantRoot(root)).toBe(expected);
  });
});

describe("selectAssistantTargets", () => {
  const connected = new Set([laptop, desk]);

  it("picks the most recent non-archived thread per machine", () => {
    const targets = selectAssistantTargets(
      [project(laptop, "p1"), project(desk, "p2"), project(desk, "other", "/work/app")],
      [
        thread(laptop, "t-old", "p1", "2026-11-01T00:00:00Z"),
        thread(laptop, "t-new", "p1", "2026-11-02T00:00:00Z"),
        thread(laptop, "t-archived", "p1", "2026-11-03T00:00:00Z", "2026-11-04T00:00:00Z"),
        thread(desk, "t-elsewhere", "other", "2026-11-05T00:00:00Z"),
      ],
      connected,
    );
    expect(targets).toEqual([
      { environmentId: laptop, projectId: "p1", threadId: "t-new" },
      { environmentId: desk, projectId: "p2", threadId: null },
    ]);
  });

  it("skips disconnected machines and archived projects", () => {
    expect(
      selectAssistantTargets(
        [
          project(laptop, "p1"),
          project(desk, "p2", "/home/me/.t3/machines/assistant", "2026-11-01T00:00:00Z"),
        ],
        [],
        new Set([laptop]),
      ),
    ).toEqual([{ environmentId: laptop, projectId: "p1", threadId: null }]);
    expect(selectAssistantTargets([project(laptop, "p1")], [], new Set())).toEqual([]);
  });
});
