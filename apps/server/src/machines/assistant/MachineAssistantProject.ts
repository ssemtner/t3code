import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { MACHINE_ASSISTANT_INSTRUCTIONS } from "./machineAssistantInstructions.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

export class MachineAssistantProjectError extends Schema.TaggedError<MachineAssistantProjectError>()(
  "MachineAssistantProjectError",
  {
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to set up the Machines assistant project.";
  }
}

export class MachineAssistantProject extends Context.Service<
  MachineAssistantProject,
  {
    readonly ensure: Effect.Effect<
      { readonly projectId: ProjectId; readonly workspaceRoot: string },
      MachineAssistantProjectError
    >;
  }
>()("t3/machines/assistant/MachineAssistantProject") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;

  const workspaceRoot = path.resolve(config.stateDir, "machines", "assistant");
  const wrap = Effect.mapError(
    (cause: unknown) => new MachineAssistantProjectError({ workspaceRoot, cause }),
  );

  const claudeSelection = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    const [instanceId] = Object.entries(settings.providerInstances)
      .filter(
        ([, instance]) =>
          instance.driver === CLAUDE_DRIVER && resolveProviderInstanceEnabled(instance),
      )
      .map(([id]) => id)
      .toSorted((left, right) => (left === "claudeAgent" ? -1 : right === "claudeAgent" ? 1 : 0));
    const model = DEFAULT_MODEL_BY_PROVIDER[CLAUDE_DRIVER];
    if (instanceId === undefined || model === undefined) return undefined;
    return { instanceId: ProviderInstanceId.make(instanceId), model };
  });

  const ensure: MachineAssistantProject["Service"]["ensure"] = Effect.gen(function* () {
    yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true });
    yield* Effect.forEach(
      ["CLAUDE.md", "AGENTS.md"],
      (name) =>
        fileSystem.writeFileString(path.join(workspaceRoot, name), MACHINE_ASSISTANT_INSTRUCTIONS),
      { concurrency: "unbounded", discard: true },
    );

    const existing = yield* projects.getByWorkspaceRoot(workspaceRoot);
    if (existing._tag === "Some") return { projectId: existing.value.id, workspaceRoot };

    const id = yield* random.uuidV4();
    const bootstrapped = yield* projects
      .bootstrap({
        commandId: CommandId.make(`machines-assistant-project:${id}`),
        projectId: ProjectId.make(id),
        title: "Machines",
        workspaceRoot,
      })
      .pipe(
        // bootstrap reads before locking; racing creates return the winner in a conflict.
        Effect.catchTags({
          ProjectConflictError: (conflict) =>
            Effect.succeed({ project: { id: conflict.conflictingProjectId }, created: false }),
        }),
      );
    if (bootstrapped.created) {
      // Set once at create, so the user's own icon and model choices are never overwritten.
      const defaultModelSelection = yield* claudeSelection;
      yield* projects.update({
        commandId: CommandId.make(`machines-assistant-project-setup:${id}`),
        projectId: bootstrapped.project.id,
        projectIcon: { kind: "lucide", name: "monitor-smartphone", color: "gray" },
        ...(defaultModelSelection === undefined ? {} : { defaultModelSelection }),
      });
    }
    return { projectId: bootstrapped.project.id, workspaceRoot };
  }).pipe(wrap, Effect.withSpan("MachineAssistantProject.ensure"));

  return MachineAssistantProject.of({ ensure });
});

export const layer = Layer.effect(MachineAssistantProject, make);
