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
import { directoryDigestOfFiles } from "../configDirectory.ts";
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
const filePayload = (content: string): MachineConfigApply.ConfigPayload => ({
  kind: "file",
  content,
  sha256: "unused",
});
const skill = (fileCount: number, name = "deploy"): MachineConfigItem => ({
  ...base,
  id: `skill:user:${name}`,
  path: `/other/.claude/skills/${name}/SKILL.md`,
  category: "skill",
  scope: "user",
  description: null,
  enabled: true,
  plugin: null,
  fileCount,
});

const encoder = new TextEncoder();
const skillFiles = (files: Record<string, string>, executable: ReadonlyArray<string> = []) =>
  Object.entries(files).map(([path, text]) => ({
    path,
    bytes: encoder.encode(text),
    executable: executable.includes(path),
  }));
const directoryPayload = (
  files: ReadonlyArray<MachineConfigApply.SkillFile>,
): MachineConfigApply.ConfigPayload => ({ kind: "directory", files, sha256: "unused" });

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
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
      expect(yield* destination(skill(3))).toBe(path.join(configDir, "skills", "deploy"));
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

      expect(yield* refusal(skill(1, "synced"))).toBe("reserved-name");
      expect(yield* refusal({ ...skill(1, "demo:hello"), scope: "plugin" })).toBe("scope");
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
        payload: filePayload("new"),
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
        payload: filePayload("new"),
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
        .write({ path: target, payload: filePayload("new"), expectedSha256: oldSha, backupPath })
        .pipe(Effect.flip);
      expect(stale._tag).toBe("MachineConfigStaleError");
      expect(yield* fileSystem.readFileString(target)).toBe("edited");
      expect(yield* fileSystem.exists(backupPath)).toBe(false);

      yield* apply.write({
        path: target,
        payload: filePayload("new"),
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

  it.effect("turns a sent skill into a directory payload and refuses what it cannot trust", () =>
    Effect.gen(function* () {
      const apply = yield* MachineConfigApply.MachineConfigApply;
      const files = skillFiles({ "SKILL.md": "steps", "scripts/run.sh": "echo" }, [
        "scripts/run.sh",
      ]);
      const digest = yield* directoryDigestOfFiles(files);
      const content = {
        id: "skill:user:deploy",
        path: "/other/.claude/skills/deploy/SKILL.md",
        content: "steps",
        sizeBytes: 10,
        sha256: digest,
        files: files.map((file) => ({
          path: file.path,
          contentBase64: Buffer.from(file.bytes).toString("base64"),
          executable: file.executable,
        })),
      };
      const payload = yield* apply.payloadOf(skill(2), content);
      expect(payload).toMatchObject({ kind: "directory", sha256: digest });
      expect(payload.kind === "directory" && payload.files).toEqual(files);

      const refusal = (
        item: MachineConfigItem,
        sent: typeof content | Omit<typeof content, "files">,
      ) =>
        apply.payloadOf(item, sent).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );
      const { files: _files, ...withoutFiles } = content;
      expect(yield* refusal(skill(2), withoutFiles)).toBe("outdated-source");
      expect(yield* refusal(skill(2), { ...content, sha256: "other" })).toBe("invalid-skill");
      expect(
        yield* refusal(skill(2), {
          ...content,
          files: [...content.files, { path: "../escape", contentBase64: "", executable: false }],
        }),
      ).toBe("invalid-skill");

      // An older source's single-file skill is its SKILL.md alone.
      const single = yield* apply.payloadOf(skill(1), { ...withoutFiles, sha256: "file sha" });
      expect(single.sha256).toBe(
        yield* directoryDigestOfFiles(skillFiles({ "SKILL.md": "steps" })),
      );
    }),
  );

  it.effect("creates a new skill directory and restore removes it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const apply = yield* MachineConfigApply.MachineConfigApply;
      const { root } = yield* makeHome();
      const target = path.join(root, ".claude", "skills", "deploy");
      const backupPath = path.join(root, "backup", "step");
      const files = skillFiles({ "SKILL.md": "steps", "scripts/run.sh": "echo" }, [
        "scripts/run.sh",
      ]);

      const result = yield* apply.write({
        path: target,
        payload: directoryPayload(files),
        expectedSha256: null,
        backupPath,
      });
      expect(result.replacedExisting).toBe(false);
      const writtenSha256 = (yield* apply.sha256Of(target))!;
      expect(writtenSha256).toBe(yield* directoryDigestOfFiles(files));
      expect(
        (yield* fileSystem.stat(path.join(target, "scripts", "run.sh"))).mode & 0o111,
      ).not.toBe(0);
      expect(yield* fileSystem.readDirectory(path.dirname(target))).toEqual(["deploy"]);

      yield* apply.restore({ path: target, backupPath, replacedExisting: false, writtenSha256 });
      expect(yield* fileSystem.exists(target)).toBe(false);
    }),
  );

  it.effect("backs up a replaced skill directory and restore brings it back", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const apply = yield* MachineConfigApply.MachineConfigApply;
      const { root } = yield* makeHome();
      const target = path.join(root, "skills", "deploy");
      const backupPath = path.join(root, "backup", "step");
      yield* fileSystem.makeDirectory(path.join(target, "old"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(target, "SKILL.md"), "old steps");
      yield* fileSystem.writeFileString(path.join(target, "old", "notes.md"), "old notes");
      const before = yield* apply.sha256Of(target);

      yield* apply.write({
        path: target,
        payload: directoryPayload(skillFiles({ "SKILL.md": "new steps" })),
        expectedSha256: before,
        backupPath,
      });
      expect(yield* fileSystem.readDirectory(target)).toEqual(["SKILL.md"]);
      expect(yield* fileSystem.readFileString(path.join(backupPath, "old", "notes.md"))).toBe(
        "old notes",
      );

      yield* apply.restore({
        path: target,
        backupPath,
        replacedExisting: true,
        writtenSha256: (yield* apply.sha256Of(target))!,
      });
      expect(yield* apply.sha256Of(target)).toBe(before);
      expect((yield* fileSystem.readDirectory(path.dirname(target))).toSorted()).toEqual([
        "deploy",
      ]);
    }),
  );

  it.effect("writes a symlinked skill directory at its target and keeps the symlink", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const apply = yield* MachineConfigApply.MachineConfigApply;
      const { root } = yield* makeHome();
      const real = path.join(root, ".agents", "skills", "deploy");
      const link = path.join(root, ".claude", "skills", "deploy");
      const backupPath = path.join(root, "backup", "step");
      yield* fileSystem.makeDirectory(real, { recursive: true });
      yield* fileSystem.writeFileString(path.join(real, "SKILL.md"), "old");
      yield* fileSystem.makeDirectory(path.dirname(link), { recursive: true });
      yield* fileSystem.symlink(path.join("..", "..", ".agents", "skills", "deploy"), link);
      const before = yield* apply.sha256Of(link);

      yield* apply.write({
        path: link,
        payload: directoryPayload(skillFiles({ "SKILL.md": "new", "ref.md": "more" })),
        expectedSha256: before,
        backupPath,
      });
      expect(yield* fileSystem.readLink(link)).toBe(
        path.join("..", "..", ".agents", "skills", "deploy"),
      );
      expect(yield* fileSystem.readFileString(path.join(real, "ref.md"))).toBe("more");
      expect(yield* fileSystem.readDirectory(path.dirname(real))).toEqual(["deploy"]);

      yield* apply.restore({
        path: link,
        backupPath,
        replacedExisting: true,
        writtenSha256: (yield* apply.sha256Of(link))!,
      });
      expect(yield* fileSystem.readLink(link)).toBe(
        path.join("..", "..", ".agents", "skills", "deploy"),
      );
      expect(yield* fileSystem.readDirectory(real)).toEqual(["SKILL.md"]);
      expect(yield* fileSystem.readFileString(path.join(real, "SKILL.md"))).toBe("old");
    }),
  );

  it.effect("refuses to replace a skill directory changed since the proposal", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const apply = yield* MachineConfigApply.MachineConfigApply;
      const { root } = yield* makeHome();
      const target = path.join(root, "skills", "deploy");
      const backupPath = path.join(root, "backup", "step");
      yield* fileSystem.makeDirectory(target, { recursive: true });
      yield* fileSystem.writeFileString(path.join(target, "SKILL.md"), "old");
      const proposed = yield* apply.sha256Of(target);
      yield* fileSystem.writeFileString(path.join(target, "extra.md"), "added meanwhile");

      const stale = yield* apply
        .write({
          path: target,
          payload: directoryPayload(skillFiles({ "SKILL.md": "new" })),
          expectedSha256: proposed,
          backupPath,
        })
        .pipe(Effect.flip);
      expect(stale._tag).toBe("MachineConfigStaleError");
      expect((yield* fileSystem.readDirectory(target)).toSorted()).toEqual([
        "SKILL.md",
        "extra.md",
      ]);
      expect(yield* fileSystem.exists(backupPath)).toBe(false);
    }),
  );
});
