import type { MachineConfigItem } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { machineProjectKey } from "@t3tools/shared/machinesInventoryDiff";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveClaudeHomePath } from "../../provider/Drivers/ClaudeHome.ts";
import { claudeProjectDirName } from "../ClaudeTranscriptPortability.ts";

const UNSUPPORTED_MESSAGES = {
  category: "This kind of Claude config cannot be copied.",
  scope: "Only user-level Claude config can be copied.",
  "multi-file-skill": "Only single-file skills can be copied.",
  "no-project-folder": "This machine has no Claude project folder for that memory file.",
} as const;

export class MachineConfigUnsupportedError extends Schema.TaggedError<MachineConfigUnsupportedError>()(
  "MachineConfigUnsupportedError",
  {
    itemId: Schema.String,
    reason: Schema.Literals(["category", "scope", "multi-file-skill", "no-project-folder"]),
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

export class MachineConfigApply extends Context.Service<
  MachineConfigApply,
  {
    /** Where an item from another machine's inventory lives on this machine. */
    readonly destinationOf: (
      item: MachineConfigItem,
    ) => Effect.Effect<string, MachineConfigUnsupportedError>;
    /** SHA-256 hex of the file's bytes, or null when it does not exist. */
    readonly sha256Of: (path: string) => Effect.Effect<string | null, MachineConfigWriteError>;
    /**
     * Refuses when the file's current sha256 is not `expectedSha256` (null = must not exist).
     * Copies an existing file to `backupPath` first, then writes atomically.
     */
    readonly write: (input: {
      readonly path: string;
      readonly content: string;
      readonly expectedSha256: string | null;
      readonly backupPath: string;
    }) => Effect.Effect<
      { readonly replacedExisting: boolean },
      MachineConfigStaleError | MachineConfigWriteError
    >;
    /** Undo of `write`; refuses when the file no longer hashes to `writtenSha256`. */
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
        if (item.fileCount !== 1) return yield* unsupported("multi-file-skill");
        const name = path.basename(path.dirname(item.path));
        if (escapesRoot(name)) return yield* unsupported("scope");
        return path.join(configDir, "skills", name, "SKILL.md");
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

  const sha256Of = Effect.fn("MachineConfigApply.sha256Of")(function* (file: string) {
    return yield* Effect.gen(function* () {
      const bytes = yield* fileSystem.readFile(file).pipe(
        Effect.asSome,
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      );
      return bytes._tag === "None" ? null : yield* digest.digestHex(Digest.sha256, bytes.value);
    }).pipe(Effect.mapError((cause) => new MachineConfigWriteError({ path: file, cause })));
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
      if (replacedExisting) {
        yield* Effect.gen(function* () {
          yield* fileSystem.makeDirectory(path.dirname(input.backupPath), { recursive: true });
          yield* fileSystem.copyFile(input.path, input.backupPath);
        }).pipe(
          Effect.mapError(
            (cause) => new MachineConfigWriteError({ path: input.backupPath, cause }),
          ),
        );
      }
      yield* replaceAtomically(input.path, encoder.encode(input.content));
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
          .remove(input.path, { force: true })
          .pipe(
            Effect.mapError((cause) => new MachineConfigWriteError({ path: input.path, cause })),
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

  return MachineConfigApply.of({ destinationOf, sha256Of, write, restore });
});

export const layer = Layer.effect(MachineConfigApply, make);
