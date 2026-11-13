import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { MACHINE_ASSISTANT_INSTRUCTIONS } from "./machineAssistantInstructions.ts";
import * as MachineAssistantProject from "./MachineAssistantProject.ts";

const layerEnrichment = ProjectEnrichmentService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
);

const layer = (baseDir: string) =>
  MachineAssistantProject.layer.pipe(
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(layerEnrichment),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(SqlitePersistence.layerFromPath(`${baseDir}/state.sqlite`)),
    Layer.provideMerge(
      ServerSettings.layerTest({
        providerInstances: {
          [ProviderInstanceId.make("claudeAgent")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
          },
        },
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

it.effect(
  "creates one Machines project that survives a restart and rewrites its instructions",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-machines-assistant-",
      });
      const root = path.resolve(baseDir, "userdata", "machines", "assistant");
      const ensure = Effect.flatMap(
        MachineAssistantProject.MachineAssistantProject,
        (assistant) => assistant.ensure,
      );

      const first = yield* ensure.pipe(Effect.provide(layer(baseDir)));
      assert.equal(first.workspaceRoot, root);

      yield* fileSystem.writeFileString(path.join(root, "CLAUDE.md"), "junk");
      yield* fileSystem.remove(path.join(root, "AGENTS.md"));

      // A fresh layer over the same state directory is a server restart.
      yield* Effect.gen(function* () {
        const second = yield* ensure;
        assert.equal(second.projectId, first.projectId);
        for (const name of ["CLAUDE.md", "AGENTS.md"]) {
          assert.equal(
            yield* fileSystem.readFileString(path.join(root, name)),
            MACHINE_ASSISTANT_INSTRUCTIONS,
          );
        }
        const matching = (yield* (yield* ProjectService.ProjectService).snapshot).projects.filter(
          (project) => project.workspaceRoot === root,
        );
        assert.lengthOf(matching, 1);
        assert.equal(matching[0]?.title, "Machines");
        assert.equal(matching[0]?.defaultModelSelection?.instanceId, "claudeAgent");
      }).pipe(Effect.provide(layer(baseDir)));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
