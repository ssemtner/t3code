import type { MachineConfigItem, MachineConfigItemContent } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { machineProjectKey } from "@t3tools/shared/machinesInventoryDiff";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { resolveClaudeHomePath } from "../../provider/Drivers/ClaudeHome.ts";
import { claudeProjectDirName } from "../ClaudeTranscriptPortability.ts";
import { directoryDigestOfFiles, directoryDigestOnDisk } from "../configDirectory.ts";

const UNSUPPORTED_MESSAGES = {
  category: "This kind of Claude config cannot be copied.",
  scope: "Only user-level Claude config can be copied.",
  "reserved-name": "The skills folder's synced entry belongs to Claude and cannot be copied.",
  "outdated-source":
    "The source machine runs an older T3 Code; update it to copy skill directories.",
  "invalid-skill": "The source machine sent a skill directory that does not match its digest.",
  "no-project-folder": "This machine has no Claude project folder for that memory file.",
} as const;

export class MachineConfigUnsupportedError extends Schema.TaggedError<MachineConfigUnsupportedError>()(
  "MachineConfigUnsupportedError",
  {
    itemId: Schema.String,
    reason: Schema.Literals([
      "category",
      "scope",
      "reserved-name",
      "outdated-source",
      "invalid-skill",
      "no-project-folder",
    ]),
  },
) {
  override get message(): string {
    return UNSUPPORTED_MESSAGES[this.reason];
  }
}

export class MachineConfigStaleError extends Schema.TaggedError<MachineConfigStaleError>()(
  "MachineConfigStaleError",
  { path: Schema.String },
) {
  override get message(): string {
    return `${this.path.slice(0, 512)} changed since the plan was proposed.`;
  }
}

export class MachineConfigWriteError extends Schema.TaggedError<MachineConfigWriteError>()(
  "MachineConfigWriteError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not write ${this.path.slice(0, 512)}.`;
  }
}

export interface SkillFile {
  /** Relative to the skill's folder, `/`-separated. */
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly executable: boolean;
}

/** What a copy-config step writes; `sha256` is what `sha256Of` reports once it is written. */
export type ConfigPayload =
  | { readonly kind: "file"; readonly content: string; readonly sha256: string }
  | {
      readonly kind: "directory";
      readonly files: ReadonlyArray<SkillFile>;
      readonly sha256: string;
    };

export class MachineConfigApply extends Context.Service<
  MachineConfigApply,
  {
    /** Where an item from another machine's inventory lives here; a skill's folder for a skill. */
    readonly destinationOf: (
      item: MachineConfigItem,
    ) => Effect.Effect<string, MachineConfigUnsupportedError>;
    /** The bytes to write for an item another machine sent, with their hash as `sha256Of` takes it. */
    readonly payloadOf: (
      item: MachineConfigItem,
      content: MachineConfigItemContent,
    ) => Effect.Effect<ConfigPayload, MachineConfigUnsupportedError>;
    /** A file's SHA-256 hex or a directory's digest (following symlinks), or null when absent. */
    readonly sha256Of: (path: string) => Effect.Effect<string | null, MachineConfigWriteError>;
    /**
     * Refuses when the current hash is not `expectedSha256` (null = must not exist). Copies what
     * exists to `backupPath` first, then replaces it as atomically as the filesystem allows. A
     * directory behind a symlink is replaced at its real path, so the symlink stays.
     */
    readonly write: (input: {
      readonly path: string;
      readonly payload: ConfigPayload;
      readonly expectedSha256: string | null;
      readonly backupPath: string;
    }) => Effect.Effect<
      { readonly replacedExisting: boolean },
      MachineConfigStaleError | MachineConfigWriteError
    >;
    /** Undo of `write`; refuses when the destination no longer hashes to `writtenSha256`. */
    readonly restore: (input: {
      readonly path: string;
      readonly backupPath: string;
      readonly replacedExisting: boolean;
      readonly writtenSha256: string;
    }) => Effect.Effect<void, MachineConfigStaleError | MachineConfigWriteError>;
  }
>()("t3/machines/assistant/MachineConfigApply") {}

const CONFIG_SUBDIRECTORIES = {
  rule: "rules",
  agent: "agents",
  command: "commands",
  "output-style": "output-styles",
} as const;

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;
  const encoder = new TextEncoder();

  const escapesRoot = (key: string) =>
    key === "" || path.isAbsolute(key) || key.split(/[\\/]/).some((segment) => segment === "..");

  const destinationOf = Effect.fn("MachineConfigApply.destinationOf")(function* (
    item: MachineConfigItem,
  ) {
    const unsupported = (reason: MachineConfigUnsupportedError["reason"]) =>
      new MachineConfigUnsupportedError({ itemId: item.id, reason });
    const home = yield* HostProcess.HomeDirectory;
    const environment = yield* HostProcess.Environment;
    const configDir = yield* resolveClaudeHomePath({ homePath: "" }, environment).pipe(
      Effect.provideService(Path.Path, path),
    );

    switch (item.category) {
      case "instructions": {
        if (item.scope !== "user") return yield* unsupported("scope");
        const key = item.id.slice("instructions:user:".length);
        if (key.startsWith("~/")) {
          const rest = key.slice(2);
          if (escapesRoot(rest)) return yield* unsupported("scope");
          return path.join(home, rest);
        }
        if (key === "~" || escapesRoot(key)) return yield* unsupported("scope");
        return path.join(configDir, key);
      }
      case "rule":
      case "agent":
      case "command":
      case "output-style": {
        if (item.scope !== "user") return yield* unsupported("scope");
        const key = item.id.slice(`${item.category}:user:`.length);
        if (escapesRoot(key)) return yield* unsupported("scope");
        return path.join(configDir, CONFIG_SUBDIRECTORIES[item.category], key);
      }
      case "skill": {
        if (item.scope !== "user") return yield* unsupported("scope");
        const name = item.id.slice("skill:user:".length);
        if (escapesRoot(name) || /[\\/]/.test(name) || name.startsWith(".")) {
          return yield* unsupported("scope");
        }
        if (name === "synced") return yield* unsupported("reserved-name");
        return path.join(configDir, "skills", name);
      }
      case "memory": {
        if (item.scope !== "project") return yield* unsupported("scope");
        const rest = item.id.slice("memory:project:".length);
        const separator = rest.indexOf(":");
        if (separator < 0) return yield* unsupported("scope");
        const projectKey = rest.slice(0, separator);
        const relative = rest.slice(separator + 1);
        if (escapesRoot(relative)) return yield* unsupported("scope");
        const projectsDir = path.join(configDir, "projects");
        const projectDirs = yield* fileSystem
          .readDirectory(projectsDir)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        const encodedHome = claudeProjectDirName(home);
        const projectDir = projectDirs
          .toSorted()
          .find((name) => machineProjectKey(name, encodedHome) === projectKey);
        if (projectDir === undefined) return yield* unsupported("no-project-folder");
        return path.join(projectsDir, projectDir, "memory", relative);
      }
      default:
        return yield* unsupported("category");
    }
  });

  const provideServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Digest.Digest, digest),
    );

  const isSafeRelative = (relative: string) =>
    relative !== "" &&
    !relative.startsWith("/") &&
    relative.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

  const payloadOf: MachineConfigApply["Service"]["payloadOf"] = Effect.fn(
    "MachineConfigApply.payloadOf",
  )(function* (item, content) {
    if (item.category !== "skill") {
      return { kind: "file" as const, content: content.content, sha256: content.sha256 };
    }
    const unsupported = (reason: MachineConfigUnsupportedError["reason"]) =>
      new MachineConfigUnsupportedError({ itemId: item.id, reason });
    if (content.files === undefined) {
      // An older source sends only SKILL.md, which is the whole skill when it is the only file.
      if (item.fileCount !== 1) return yield* unsupported("outdated-source");
      const files = [
        { path: "SKILL.md", bytes: encoder.encode(content.content), executable: false },
      ];
      return {
        kind: "directory" as const,
        files,
        sha256: yield* provideServices(directoryDigestOfFiles(files)),
      };
    }
    const files = content.files.map((file) => ({
      path: file.path,
      bytes: new Uint8Array(Buffer.from(file.contentBase64, "base64")),
      executable: file.executable,
    }));
    const paths = new Set(files.map((file) => file.path));
    if (
      paths.size !== files.length ||
      !paths.has("SKILL.md") ||
      !files.every((file) => isSafeRelative(file.path))
    ) {
      return yield* unsupported("invalid-skill");
    }
    const sha256 = yield* provideServices(directoryDigestOfFiles(files));
    if (sha256 !== content.sha256) return yield* unsupported("invalid-skill");
    return { kind: "directory" as const, files, sha256 };
  });

  const sha256Of = Effect.fn("MachineConfigApply.sha256Of")(function* (target: string) {
    return yield* Effect.gen(function* () {
      const info = yield* fileSystem.stat(target).pipe(
        Effect.asSome,
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      );
      if (info._tag === "None") return null;
      if (info.value.type === "Directory") {
        return (yield* provideServices(directoryDigestOnDisk(target))).sha256;
      }
      return yield* digest.digestHex(Digest.sha256, yield* fileSystem.readFile(target));
    }).pipe(Effect.mapError((cause) => new MachineConfigWriteError({ path: target, cause })));
  });

  /** The directory a path names, through a symlink when it is one; the path itself when absent. */
  const realDirectory = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => target));

  /** Moves `staged` to `target`, keeping the old `target` until the new one is in place. */
  const swapDirectory = Effect.fnUntraced(function* (
    target: string,
    staged: string,
    exists: boolean,
  ) {
    if (!exists) {
      yield* fileSystem.rename(staged, target);
      return;
    }
    const old = `${target}.old-${yield* random.uuidV4()}`;
    yield* fileSystem.rename(target, old);
    yield* fileSystem
      .rename(staged, target)
      .pipe(Effect.tapError(() => fileSystem.rename(old, target).pipe(Effect.ignore)));
    yield* fileSystem.remove(old, { recursive: true, force: true }).pipe(Effect.ignore);
  });

  /** Fills a sibling of `target` by `stage`, then swaps it in; the sibling never outlives a failure. */
  const replaceDirectory = Effect.fn("MachineConfigApply.replaceDirectory")(function* (
    target: string,
    exists: boolean,
    stage: (staged: string) => Effect.Effect<void, PlatformError.PlatformError>,
  ) {
    yield* Effect.gen(function* () {
      const staged = `${target}.tmp-${yield* random.uuidV4()}`;
      yield* Effect.gen(function* () {
        yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
        yield* stage(staged);
        yield* swapDirectory(target, staged, exists);
      }).pipe(
        Effect.tapError(() =>
          fileSystem.remove(staged, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
      );
    }).pipe(Effect.mapError((cause) => new MachineConfigWriteError({ path: target, cause })));
  });

  const stageFiles = (files: ReadonlyArray<SkillFile>) => (staged: string) =>
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(staged, { recursive: true });
      for (const file of files) {
        const filePath = path.join(staged, ...file.path.split("/"));
        yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fileSystem.writeFile(filePath, file.bytes);
        if (file.executable) yield* fileSystem.chmod(filePath, 0o755);
      }
    });

  const replaceAtomically = Effect.fn("MachineConfigApply.replaceAtomically")(function* (
    file: string,
    bytes: Uint8Array,
  ) {
    yield* Effect.gen(function* () {
      const temporary = `${file}.tmp-${yield* random.uuidV4()}`;
      yield* Effect.gen(function* () {
        yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
        yield* fileSystem.writeFile(temporary, bytes);
        yield* fileSystem.rename(temporary, file);
      }).pipe(
        Effect.tapError(() => fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
      );
    }).pipe(Effect.mapError((cause) => new MachineConfigWriteError({ path: file, cause })));
  });

  const write: MachineConfigApply["Service"]["write"] = Effect.fn("MachineConfigApply.write")(
    function* (input) {
      const current = yield* sha256Of(input.path);
      if (current !== input.expectedSha256) {
        return yield* new MachineConfigStaleError({ path: input.path });
      }
      const replacedExisting = current !== null;
      const { payload } = input;
      const target = payload.kind === "directory" ? yield* realDirectory(input.path) : input.path;
      if (replacedExisting) {
        yield* Effect.gen(function* () {
          yield* fileSystem.makeDirectory(path.dirname(input.backupPath), { recursive: true });
          if (payload.kind === "file") {
            yield* fileSystem.copyFile(input.path, input.backupPath);
            return;
          }
          yield* fileSystem.remove(input.backupPath, { recursive: true, force: true });
          yield* fileSystem.copy(target, input.backupPath);
        }).pipe(
          Effect.mapError(
            (cause) => new MachineConfigWriteError({ path: input.backupPath, cause }),
          ),
        );
      }
      if (payload.kind === "file") {
        yield* replaceAtomically(input.path, encoder.encode(payload.content));
      } else {
        yield* replaceDirectory(target, replacedExisting, stageFiles(payload.files));
      }
      return { replacedExisting };
    },
  );

  const restore: MachineConfigApply["Service"]["restore"] = Effect.fn("MachineConfigApply.restore")(
    function* (input) {
      if ((yield* sha256Of(input.path)) !== input.writtenSha256) {
        return yield* new MachineConfigStaleError({ path: input.path });
      }
      if (!input.replacedExisting) {
        yield* fileSystem
          .remove(input.path, { recursive: true, force: true })
          .pipe(
            Effect.mapError((cause) => new MachineConfigWriteError({ path: input.path, cause })),
          );
        return;
      }
      const backupInfo = yield* fileSystem
        .stat(input.backupPath)
        .pipe(
          Effect.mapError(
            (cause) => new MachineConfigWriteError({ path: input.backupPath, cause }),
          ),
        );
      if (backupInfo.type === "Directory") {
        yield* replaceDirectory(yield* realDirectory(input.path), true, (staged) =>
          fileSystem.copy(input.backupPath, staged),
        );
        return;
      }
      const backup = yield* fileSystem
        .readFile(input.backupPath)
        .pipe(
          Effect.mapError(
            (cause) => new MachineConfigWriteError({ path: input.backupPath, cause }),
          ),
        );
      yield* replaceAtomically(input.path, backup);
    },
  );

  return MachineConfigApply.of({ destinationOf, payloadOf, sha256Of, write, restore });
});

export const layer = Layer.effect(MachineConfigApply, make);
