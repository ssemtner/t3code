import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { MachineConfigItem } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { claudeProjectDirName } from "../ClaudeTranscriptPortability.ts";
import * as MachineConfigApply from "./MachineConfigApply.ts";

const base = {
  name: "n",
  path: "/other/x",
  project: null,
  sizeBytes: 1,
  sha256: "x",
  modifiedAt: null,
} as const;
const agent = (id: string): MachineConfigItem => ({
  ...base,
  id,
  category: "agent",
  scope: "user",
  description: null,
});
const skill = (fileCount: number): MachineConfigItem => ({
  ...base,
  id: "skill:user:deploy",
  path: "/other/.claude/skills/deploy/SKILL.md",
  category: "skill",
  scope: "user",
  description: null,
  enabled: true,
  plugin: null,
  fileCount,
});

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    MachineConfigApply.layer.pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
)("MachineConfigApply", (it) => {
  const makeHome = Effect.fn("makeHome")(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-config-apply-" });
    const home = path.join(root, "home");
    const inMachine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, {}),
      );
    return { root, home, inMachine };
  });

  it.effect("maps inventory ids to this machine and refuses what it cannot copy", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const apply = yield* MachineConfigApply.MachineConfigApply;
      const { home, inMachine } = yield* makeHome();
      const configDir = path.join(home, ".claude");
      yield* fileSystem.makeDirectory(
        path.join(configDir, "projects", `${claudeProjectDirName(home)}-Developer-Proj`),
        {
          recursive: true,
        },
      );
      const destination = (item: MachineConfigItem) => inMachine(apply.destinationOf(item));
      const refusal = (item: MachineConfigItem) =>
        destination(item).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );

      expect(yield* destination(agent("agent:user:team/reviewer.md"))).toBe(
        path.join(configDir, "agents", "team/reviewer.md"),
      );
      expect(
        yield* destination({
          ...base,
          id: "instructions:user:~/notes/shared.md",
          category: "instructions",
          scope: "user",
          importedBy: null,
        }),
      ).toBe(path.join(home, "notes/shared.md"));
      expect(yield* destination(skill(1))).toBe(
        path.join(configDir, "skills", "deploy", "SKILL.md"),
      );
      expect(
        yield* destination({
          ...base,
          id: "memory:project:~/developer-proj:notes/a.md",
          category: "memory",
          scope: "project",
          projectDir: "x",
        }),
      ).toBe(
        path.join(
          configDir,
          "projects",
          `${claudeProjectDirName(home)}-Developer-Proj`,
          "memory",
          "notes/a.md",
        ),
      );

      expect(yield* refusal(skill(3))).toBe("multi-file-skill");
      expect(yield* refusal({ ...agent("agent:managed:x.md"), scope: "managed" })).toBe("scope");
      expect(yield* refusal(agent("agent:user:../escape.md"))).toBe("scope");
      expect(
        yield* refusal({
          ...base,
          id: "mcp-server:user:s",
          category: "mcp-server",
          scope: "user",
          mcpScope: "user",
          transport: "stdio",
          command: null,
        }),
      ).toBe("category");
    }),
  );

  it.effect("creates a missing file and restore removes it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const apply = yield* MachineConfigApply.MachineConfigApply;
      const { root } = yield* makeHome();
      const target = path.join(root, "a", "b", "file.md");
      const backupPath = path.join(root, "backup", "step");

      const result = yield* apply.write({
        path: target,
        content: "new",
        expectedSha256: null,
        backupPath,
      });
      expect(result.replacedExisting).toBe(false);
      expect(yield* fileSystem.readFileString(target)).toBe("new");

      yield* apply.restore({
        path: target,
        backupPath,
        replacedExisting: false,
        writtenSha256: (yield* apply.sha256Of(target))!,
      });
      expect(yield* apply.sha256Of(target)).toBeNull();
    }),
  );

  it.effect("backs up and restores an overwritten file", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const apply = yield* MachineConfigApply.MachineConfigApply;
      const { root } = yield* makeHome();
      const target = path.join(root, "file.md");
      const backupPath = path.join(root, "backup", "step");
      yield* fileSystem.writeFileString(target, "old");

      const result = yield* apply.write({
        path: target,
        content: "new",
        expectedSha256: yield* apply.sha256Of(target),
        backupPath,
      });
      expect(result.replacedExisting).toBe(true);
      expect(yield* fileSystem.readFileString(backupPath)).toBe("old");
      expect(yield* fileSystem.readFileString(target)).toBe("new");

      yield* apply.restore({
        path: target,
        backupPath,
        replacedExisting: true,
        writtenSha256: (yield* apply.sha256Of(target))!,
      });
      expect(yield* fileSystem.readFileString(target)).toBe("old");
    }),
  );

  it.effect("refuses a write or restore over changes made since", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const apply = yield* MachineConfigApply.MachineConfigApply;
      const { root } = yield* makeHome();
      const target = path.join(root, "file.md");
      const backupPath = path.join(root, "backup", "step");
      yield* fileSystem.writeFileString(target, "old");
      const oldSha = yield* apply.sha256Of(target);

      yield* fileSystem.writeFileString(target, "edited");
      const stale = yield* apply
        .write({ path: target, content: "new", expectedSha256: oldSha, backupPath })
        .pipe(Effect.flip);
      expect(stale._tag).toBe("MachineConfigStaleError");
      expect(yield* fileSystem.readFileString(target)).toBe("edited");
      expect(yield* fileSystem.exists(backupPath)).toBe(false);

      yield* apply.write({
        path: target,
        content: "new",
        expectedSha256: yield* apply.sha256Of(target),
        backupPath,
      });
      const writtenSha256 = (yield* apply.sha256Of(target))!;
      yield* fileSystem.writeFileString(target, "edited after");
      const refused = yield* apply
        .restore({ path: target, backupPath, replacedExisting: true, writtenSha256 })
        .pipe(Effect.flip);
      expect(refused._tag).toBe("MachineConfigStaleError");
      expect(yield* fileSystem.readFileString(target)).toBe("edited after");
    }),
  );
});
