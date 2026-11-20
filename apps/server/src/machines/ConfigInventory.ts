import {
  MACHINE_CONFIG_READABLE_CATEGORIES,
  MachineConfigCategory,
  type MachineConfigInventory,
  type MachineConfigItem,
  type MachineConfigItemContent,
  type MachineConfigProblem,
  type MachineConfigScope,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { homeRelativePath, machineProjectKey } from "@t3tools/shared/machinesInventoryDiff";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { claudeAccountConfigPath } from "../provider/claudeResetCredits.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { discoverClaudeSkills } from "../provider/Drivers/ClaudeSkills.ts";
import { claudeProjectDirName } from "./ClaudeTranscriptPortability.ts";
import {
  directoryDigestOfFiles,
  directoryDigestOnDisk,
  listFiles,
  relativeKey as relativeKeyIn,
} from "./configDirectory.ts";

export class ConfigItemNotFoundError extends Schema.TaggedError<ConfigItemNotFoundError>()(
  "ConfigItemNotFoundError",
  { id: Schema.String },
) {
  override get message(): string {
    return `No Claude config item ${this.id} on this machine.`;
  }
}

export class ConfigItemNotReadableError extends Schema.TaggedError<ConfigItemNotReadableError>()(
  "ConfigItemNotReadableError",
  { id: Schema.String, category: MachineConfigCategory },
) {
  override get message(): string {
    return `Claude config items of category ${this.category} cannot be read; they can hold secrets.`;
  }
}

export class ConfigItemTooLargeError extends Schema.TaggedError<ConfigItemTooLargeError>()(
  "ConfigItemTooLargeError",
  {
    id: Schema.String,
    path: Schema.String,
    sizeBytes: Schema.Number,
    limitBytes: Schema.Number,
    fileCount: Schema.optionalKey(Schema.Number),
    limitFiles: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    if (this.fileCount !== undefined && this.limitFiles !== undefined) {
      return `${this.path} has ${this.fileCount} files, over the ${this.limitFiles} file read limit.`;
    }
    return `${this.path} is ${this.sizeBytes} bytes, over the ${this.limitBytes} byte read limit.`;
  }
}

export class ConfigItemReadError extends Schema.TaggedError<ConfigItemReadError>()(
  "ConfigItemReadError",
  { id: Schema.String, path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read ${this.path}.`;
  }
}

/** Overrides the platform's managed-policy directory (`/etc/claude-code` on Linux). */
export const ClaudeManagedDirectory = Context.Reference<string | null>(
  "t3/machines/ConfigInventory/ClaudeManagedDirectory",
  { defaultValue: () => null },
);

export class ConfigInventory extends Context.Service<
  ConfigInventory,
  {
    readonly scan: (input: {
      readonly projectRoots: ReadonlyArray<string>;
    }) => Effect.Effect<MachineConfigInventory>;
    /** One item by id, as `scan` would report it; scans only for entries of shared files. */
    readonly findItem: (id: string) => Effect.Effect<MachineConfigItem, ConfigItemNotFoundError>;
    /**
     * Only for categories in `MACHINE_CONFIG_READABLE_CATEGORIES`. A user skill returns every file
     * of its directory and the directory digest; a plugin skill returns its SKILL.md.
     */
    readonly readItem: (
      id: string,
    ) => Effect.Effect<
      MachineConfigItemContent,
      | ConfigItemNotFoundError
      | ConfigItemNotReadableError
      | ConfigItemTooLargeError
      | ConfigItemReadError
    >;
  }
>()("t3/machines/ConfigInventory") {}

const READ_LIMIT_BYTES = 256 * 1024;
const SKILL_READ_LIMIT_BYTES = 5 * 1024 * 1024;
const SKILL_READ_LIMIT_FILES = 200;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ItemDraft = DistributiveOmit<MachineConfigItem, "sizeBytes" | "sha256" | "modifiedAt">;

/** A file-backed item before hashing; `readItem` resolves ids through these without hashing. */
interface FileCandidate {
  readonly path: string;
  /** A skill hashes its whole directory. */
  readonly directory?: string;
  readonly draft: ItemDraft;
}

interface ScanContext {
  readonly home: string;
  readonly configDir: string;
  readonly managedDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly encodedHome: string;
  /** Real project paths by Claude's encoded folder name, to label memory directories. */
  readonly projectPaths: ReadonlyMap<string, string>;
}

type JsonRead =
  | { readonly kind: "missing" }
  | { readonly kind: "problem"; readonly problem: MachineConfigProblem }
  | { readonly kind: "ok"; readonly value: unknown };

const decodeLenientJson = Schema.decodeUnknownEffect(fromLenientJson(Schema.Unknown));

const isMachineConfigCategory = Schema.is(MachineConfigCategory);

/** Text with this machine's home directory written as `~`. */
const withHomeAsTilde = (text: string, home: string) =>
  text === home ? "~" : text.replaceAll(`${home}/`, "~/");

// Locale-independent, so two machines order ids the same way.
const compareStrings = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/** First word of a command line, without quotes or directories: `/usr/bin/node x.js` -> `node`. */
function executableName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return (
    first
      .replace(/^["']|["']$/g, "")
      .split(/[\\/]/)
      .pop() ?? ""
  );
}

function managedDirectoryFor(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

function frontmatterField(contents: string, field: "name" | "description"): string | null {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return null;
  try {
    const parsed: unknown = parseYamlDocument(match[1] ?? "");
    return isRecord(parsed) ? (stringOrNull(parsed[field])?.trim() ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * `@path` imports of a CLAUDE.md, as Claude Code 2.1 finds them: outside code blocks, code spans
 * and HTML comments, `#fragment` dropped, `\ ` for spaces, and only path-like targets.
 */
export function claudeMdImports(contents: string): ReadonlyArray<string> {
  const prose = contents
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, " ")
    .replace(/(`+)[\s\S]*?\1/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const imports = new Set<string>();
  for (const match of prose.matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/g)) {
    const target = (match[1] ?? "").split("#")[0]?.replaceAll("\\ ", " ") ?? "";
    if (
      target.startsWith("./") ||
      target.startsWith("~/") ||
      (target.startsWith("/") && target !== "/") ||
      (!target.startsWith("@") && !/^[#%^&*()]+/.test(target) && /^[a-zA-Z0-9._-]/.test(target))
    ) {
      imports.add(target);
    }
  }
  return [...imports];
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const environmentIdentity = yield* ServerEnvironmentIdentity;
  const encoder = new TextEncoder();

  // The helpers below are untraced: they run per file or entry inside one scan or readItem span.
  const provideFileSystem = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Digest.Digest, digest),
    );

  const sha256 = (data: Uint8Array) => digest.digestHex(Digest.sha256, data);

  const isoMtime = (info: FileSystem.File.Info | undefined) =>
    info === undefined ? null : Option.getOrNull(Option.map(info.mtime, (d) => d.toISOString()));

  const relativeKey = (root: string, file: string) => relativeKeyIn(path, root, file);

  const projectKey = (ctx: ScanContext, projectPath: string) =>
    machineProjectKey(claudeProjectDirName(projectPath), ctx.encodedHome);

  /** Canonical JSON of a config entry: sorted keys, and the home directory written as `~`. */
  const canonicalJson = (ctx: ScanContext, value: unknown): string => {
    const normalize = (node: unknown): unknown => {
      if (typeof node === "string") return withHomeAsTilde(node, ctx.home);
      if (Array.isArray(node)) return node.map(normalize);
      if (isRecord(node)) {
        return Object.fromEntries(
          Object.keys(node)
            .toSorted()
            .map((key) => [key, normalize(node[key])]),
        );
      }
      return node;
    };
    return JSON.stringify(normalize(value)) ?? "null";
  };

  const entryItem = Effect.fnUntraced(function* (
    ctx: ScanContext,
    draft: ItemDraft,
    value: unknown,
  ): Effect.fn.Return<MachineConfigItem> {
    const bytes = encoder.encode(canonicalJson(ctx, value));
    return {
      ...draft,
      sizeBytes: bytes.byteLength,
      sha256: yield* sha256(bytes),
      modifiedAt: null,
    };
  });

  const readJson = Effect.fnUntraced(function* (filePath: string): Effect.fn.Return<JsonRead> {
    const contents = yield* fileSystem.readFileString(filePath).pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      Effect.orElseSucceed(() => undefined),
    );
    if (contents === undefined) {
      return { kind: "problem", problem: { path: filePath, reason: "unreadable" } };
    }
    if (Option.isNone(contents)) return { kind: "missing" };
    // The decode error quotes the file, which can hold secrets; only the path survives.
    const value = yield* decodeLenientJson(contents.value).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none()),
    );
    return Option.isSome(value)
      ? { kind: "ok", value: value.value }
      : { kind: "problem", problem: { path: filePath, reason: "malformed" } };
  });

  const isMarkdown = (name: string) => name.endsWith(".md");
  const withoutMd = (key: string) => key.replace(/\.md$/, "");

  const readText = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));

  const markdownCandidates = Effect.fnUntraced(function* (
    category: "rule" | "agent" | "command" | "output-style",
    scope: MachineConfigScope,
    root: string,
  ) {
    const candidates: Array<FileCandidate> = [];
    for (const file of yield* listFiles(root, isMarkdown)) {
      const key = relativeKey(root, file);
      const base = { id: `${category}:${scope}:${key}`, scope, path: file, project: null };
      if (category === "rule") {
        candidates.push({ path: file, draft: { ...base, category, name: withoutMd(key) } });
        continue;
      }
      const contents = yield* readText(file);
      const description = frontmatterField(contents, "description");
      const name =
        category === "command"
          ? withoutMd(key).replaceAll("/", ":")
          : (frontmatterField(contents, "name") ?? withoutMd(path.basename(file)));
      candidates.push({ path: file, draft: { ...base, category, name, description } });
    }
    return candidates;
  });

  const instructionCandidates = Effect.fnUntraced(function* (ctx: ScanContext) {
    const candidates: Array<FileCandidate> = [];
    const managedPath = path.join(ctx.managedDir, "CLAUDE.md");
    if (yield* fileSystem.exists(managedPath).pipe(Effect.orElseSucceed(() => false))) {
      candidates.push({
        path: managedPath,
        draft: {
          id: "instructions:managed:CLAUDE.md",
          category: "instructions",
          scope: "managed",
          name: "CLAUDE.md",
          path: managedPath,
          project: null,
          importedBy: null,
        },
      });
    }
    const userPath = path.join(ctx.configDir, "CLAUDE.md");
    const contents = yield* fileSystem
      .readFileString(userPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) return candidates;
    const userId = "instructions:user:CLAUDE.md";
    candidates.push({
      path: userPath,
      draft: {
        id: userId,
        category: "instructions",
        scope: "user",
        name: "CLAUDE.md",
        path: userPath,
        project: null,
        importedBy: null,
      },
    });
    const seen = new Set([userPath]);
    for (const target of claudeMdImports(contents)) {
      const importPath = path.resolve(
        path.dirname(userPath),
        target.startsWith("~/") ? expandHomePath(target, ctx.home) : target,
      );
      if (seen.has(importPath)) continue;
      seen.add(importPath);
      const info = yield* fileSystem.stat(importPath).pipe(Effect.orElseSucceed(() => undefined));
      if (info?.type !== "File") continue;
      const inConfig = !path.relative(ctx.configDir, importPath).startsWith("..");
      const key = inConfig
        ? relativeKey(ctx.configDir, importPath)
        : homeRelativePath(importPath, ctx.home);
      candidates.push({
        path: importPath,
        draft: {
          id: `instructions:user:${key}`,
          category: "instructions",
          scope: "user",
          name: key,
          path: importPath,
          project: null,
          importedBy: userId,
        },
      });
    }
    return candidates;
  });

  const skillCandidates = Effect.fnUntraced(function* (ctx: ScanContext) {
    const userSkills = path.join(ctx.configDir, "skills");
    const skills = yield* discoverClaudeSkills({ homePath: "" }, undefined, ctx.environment);
    return skills.map((skill): FileCandidate => {
      const directory = path.dirname(skill.path);
      const isUser = !path.relative(userSkills, skill.path).startsWith("..");
      const scope = isUser ? "user" : "plugin";
      return {
        path: skill.path,
        directory,
        draft: {
          id: `skill:${scope}:${skill.name}`,
          category: "skill",
          scope,
          name: skill.name,
          path: skill.path,
          project: null,
          description: skill.description ?? null,
          enabled: skill.enabled,
          plugin: isUser ? null : (skill.name.split(":")[0] ?? null),
          fileCount: 0,
        },
      };
    });
  });

  const memoryCandidates = Effect.fnUntraced(function* (ctx: ScanContext) {
    const projectsDir = path.join(ctx.configDir, "projects");
    const projectDirs = yield* fileSystem
      .readDirectory(projectsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const candidates: Array<FileCandidate> = [];
    for (const projectDir of projectDirs.toSorted()) {
      const memoryDir = path.join(projectsDir, projectDir, "memory");
      const key = machineProjectKey(projectDir, ctx.encodedHome);
      const realPath = ctx.projectPaths.get(projectDir);
      const project = realPath === undefined ? projectDir : homeRelativePath(realPath, ctx.home);
      for (const file of yield* listFiles(memoryDir, () => true)) {
        const relative = relativeKey(memoryDir, file);
        candidates.push({
          path: file,
          draft: {
            id: `memory:project:${key}:${relative}`,
            category: "memory",
            scope: "project",
            name: relative,
            path: file,
            project,
            projectDir,
          },
        });
      }
    }
    return candidates;
  });

  const fileCandidates = Effect.fnUntraced(function* (ctx: ScanContext) {
    const groups = yield* Effect.all([
      instructionCandidates(ctx),
      markdownCandidates("rule", "user", path.join(ctx.configDir, "rules")),
      markdownCandidates("rule", "managed", path.join(ctx.managedDir, ".claude", "rules")),
      markdownCandidates("agent", "user", path.join(ctx.configDir, "agents")),
      markdownCandidates("command", "user", path.join(ctx.configDir, "commands")),
      markdownCandidates("output-style", "user", path.join(ctx.configDir, "output-styles")),
      skillCandidates(ctx),
      memoryCandidates(ctx),
    ]);
    return groups.flat();
  });

  const hashCandidate = Effect.fnUntraced(function* (
    candidate: FileCandidate,
  ): Effect.fn.Return<MachineConfigItem> {
    const info = yield* fileSystem.stat(candidate.path).pipe(Effect.orElseSucceed(() => undefined));
    if (candidate.directory === undefined) {
      const bytes = yield* fileSystem
        .readFile(candidate.path)
        .pipe(Effect.orElseSucceed(() => new Uint8Array()));
      return {
        ...candidate.draft,
        sizeBytes: bytes.byteLength,
        sha256: yield* sha256(bytes),
        modifiedAt: isoMtime(info),
      };
    }
    const tree = yield* provideFileSystem(directoryDigestOnDisk(candidate.directory));
    return {
      ...candidate.draft,
      ...(candidate.draft.category === "skill" ? { fileCount: tree.fileCount } : {}),
      sizeBytes: tree.sizeBytes,
      sha256: tree.sha256,
      modifiedAt: isoMtime(info),
    };
  });

  const mcpItems = Effect.fnUntraced(function* (
    ctx: ScanContext,
    servers: unknown,
    source: {
      readonly path: string;
      readonly mcpScope: "user" | "local" | "project" | "managed";
      readonly projectPath: string | null;
    },
  ) {
    if (!isRecord(servers)) return [];
    const scope: MachineConfigScope =
      source.mcpScope === "user" ? "user" : source.mcpScope === "managed" ? "managed" : "project";
    const prefix =
      source.projectPath === null
        ? `mcp-server:${source.mcpScope}`
        : `mcp-server:${source.mcpScope}:${projectKey(ctx, source.projectPath)}`;
    const items: Array<MachineConfigItem> = [];
    for (const [name, config] of Object.entries(servers)) {
      const entry = isRecord(config) ? config : {};
      const transport =
        stringOrNull(entry.type) ?? (typeof entry.command === "string" ? "stdio" : "unknown");
      const command =
        transport === "stdio" && typeof entry.command === "string"
          ? executableName(entry.command)
          : null;
      items.push(
        yield* entryItem(
          ctx,
          {
            id: `${prefix}:${name}`,
            category: "mcp-server",
            scope,
            name,
            path: source.path,
            project:
              source.projectPath === null ? null : homeRelativePath(source.projectPath, ctx.home),
            mcpScope: source.mcpScope,
            transport,
            command,
          },
          config,
        ),
      );
    }
    return items;
  });

  const marketplaceItem = (
    ctx: ScanContext,
    scope: MachineConfigScope,
    name: string,
    filePath: string,
    source: unknown,
  ) => {
    const record = isRecord(source) ? source : {};
    const sourceType = stringOrNull(record.source) ?? "unknown";
    const localPath = stringOrNull(record.path);
    // Only a git or URL source's host: the URL itself can carry a token.
    const location =
      sourceType === "github"
        ? stringOrNull(record.repo)
        : localPath !== null
          ? homeRelativePath(localPath, ctx.home)
          : (URL.parse(stringOrNull(record.url) ?? "")?.host ?? null);
    return entryItem(
      ctx,
      {
        id: `marketplace:${scope}:${name}`,
        category: "marketplace",
        scope,
        name,
        path: filePath,
        project: null,
        sourceType,
        location,
      },
      source,
    );
  };

  const settingsItems = Effect.fnUntraced(function* (
    ctx: ScanContext,
    settings: Record<string, unknown>,
    source: { readonly path: string; readonly scope: MachineConfigScope },
    installedPlugins: Record<string, unknown>,
  ) {
    const { scope } = source;
    const items: Array<MachineConfigItem> = [];
    const base = { scope, path: source.path, project: null };

    const hooks = isRecord(settings.hooks) ? settings.hooks : {};
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!isRecord(group)) continue;
        const matcher = stringOrNull(group.matcher);
        const handlers = (Array.isArray(group.hooks) ? group.hooks : []).filter(isRecord);
        items.push(
          yield* entryItem(
            ctx,
            {
              ...base,
              id: `hook:${scope}:${event}:${matcher ?? "*"}`,
              category: "hook",
              name: matcher === null ? event : `${event} ${matcher}`,
              event,
              matcher,
              handlerTypes: [
                ...new Set(handlers.map((handler) => stringOrNull(handler.type) ?? "unknown")),
              ].toSorted(),
              commands: handlers.flatMap((handler) =>
                typeof handler.command === "string" ? [executableName(handler.command)] : [],
              ),
            },
            group,
          ),
        );
      }
    }

    const permissions = isRecord(settings.permissions) ? settings.permissions : {};
    for (const behavior of ["allow", "deny", "ask", "additionalDirectories"] as const) {
      const rules = permissions[behavior];
      if (!Array.isArray(rules)) continue;
      const label = behavior === "additionalDirectories" ? "additionalDirectory" : behavior;
      for (const rule of rules) {
        if (typeof rule !== "string") continue;
        const normalized = withHomeAsTilde(rule, ctx.home);
        items.push(
          yield* entryItem(
            ctx,
            {
              ...base,
              id: `permission:${scope}:${label}:${normalized}`,
              category: "permission",
              name: rule,
              behavior: label,
              rule,
            },
            rule,
          ),
        );
      }
    }
    const defaultMode = stringOrNull(permissions.defaultMode);
    if (defaultMode !== null) {
      items.push(
        yield* entryItem(
          ctx,
          {
            ...base,
            id: `permission:${scope}:defaultMode`,
            category: "permission",
            name: "defaultMode",
            behavior: "defaultMode",
            rule: defaultMode,
          },
          defaultMode,
        ),
      );
    }

    // Names only: the value is hashed so machines compare, and never returned.
    const env = isRecord(settings.env) ? settings.env : {};
    for (const [name, value] of Object.entries(env)) {
      items.push(
        yield* entryItem(
          ctx,
          { ...base, id: `env:${scope}:${name}`, category: "env", name },
          value,
        ),
      );
    }

    const enabledPlugins = isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {};
    for (const [key, value] of Object.entries(enabledPlugins)) {
      const records = installedPlugins[key];
      const install = (Array.isArray(records) ? records : [])
        .filter(isRecord)
        .find((record) => record.scope === "user" || record.scope === "managed");
      const version = stringOrNull(install?.version);
      const at = key.lastIndexOf("@");
      items.push(
        yield* entryItem(
          ctx,
          {
            ...base,
            id: `plugin:${scope}:${key}`,
            category: "plugin",
            name: at > 0 ? key.slice(0, at) : key,
            enabled: value === true,
            marketplace: at > 0 ? key.slice(at + 1) : null,
            version,
          },
          { enabled: value, version },
        ),
      );
    }

    // User marketplaces come from known_marketplaces.json, which the CLI keeps installed.
    if (scope === "managed" && isRecord(settings.extraKnownMarketplaces)) {
      for (const [name, declaration] of Object.entries(settings.extraKnownMarketplaces)) {
        items.push(
          yield* marketplaceItem(
            ctx,
            scope,
            name,
            source.path,
            isRecord(declaration) ? declaration.source : undefined,
          ),
        );
      }
    }
    return items;
  });

  const resolveContext = Effect.fnUntraced(function* (
    projectPaths: ReadonlyMap<string, string> = new Map(),
  ) {
    const home = yield* HostProcess.HomeDirectory;
    const environment = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;
    const managedOverride = yield* ClaudeManagedDirectory;
    const configDir = yield* resolveClaudeHomePath({ homePath: "" }, environment);
    return {
      home,
      configDir,
      managedDir: managedOverride ?? managedDirectoryFor(platform),
      environment,
      encodedHome: claudeProjectDirName(home),
      projectPaths,
    } satisfies ScanContext;
  });

  const readClaudeJson = Effect.fnUntraced(function* (projectRoots: ReadonlyArray<string>) {
    const environment = yield* HostProcess.Environment;
    const customConfigDir = (environment.CLAUDE_CONFIG_DIR?.trim() ?? "") !== "";
    const claudeJsonPath = yield* claudeAccountConfigPath(
      customConfigDir ? yield* resolveClaudeHomePath({ homePath: "" }, environment) : undefined,
    );
    const claudeJson = yield* readJson(claudeJsonPath);
    const claudeJsonValue =
      claudeJson.kind === "ok" && isRecord(claudeJson.value) ? claudeJson.value : {};
    const knownProjects = isRecord(claudeJsonValue.projects) ? claudeJsonValue.projects : {};
    const projectPaths = new Map<string, string>();
    for (const projectPath of [...projectRoots, ...Object.keys(knownProjects)]) {
      const encoded = claudeProjectDirName(projectPath);
      if (!projectPaths.has(encoded)) projectPaths.set(encoded, projectPath);
    }
    return { claudeJsonPath, claudeJson, claudeJsonValue, knownProjects, projectPaths };
  });

  const scan: ConfigInventory["Service"]["scan"] = Effect.fn("ConfigInventory.scan")(function* ({
    projectRoots,
  }) {
    const problems: Array<MachineConfigProblem> = [];
    const items: Array<MachineConfigItem> = [];
    const { claudeJsonPath, claudeJson, claudeJsonValue, knownProjects, projectPaths } =
      yield* readClaudeJson(projectRoots);
    if (claudeJson.kind === "problem") problems.push(claudeJson.problem);
    const ctx = yield* resolveContext(projectPaths);
    const readJsonRecord = Effect.fnUntraced(function* (filePath: string) {
      const read = yield* readJson(filePath);
      if (read.kind === "problem") problems.push(read.problem);
      return read.kind === "ok" && isRecord(read.value) ? read.value : undefined;
    });

    items.push(
      ...(yield* mcpItems(ctx, claudeJsonValue.mcpServers, {
        path: claudeJsonPath,
        mcpScope: "user",
        projectPath: null,
      })),
    );
    for (const [projectPath, project] of Object.entries(knownProjects)) {
      if (!isRecord(project)) continue;
      items.push(
        ...(yield* mcpItems(ctx, project.mcpServers, {
          path: claudeJsonPath,
          mcpScope: "local",
          projectPath,
        })),
      );
    }
    for (const projectRoot of new Set(projectRoots)) {
      const mcpJsonPath = path.join(projectRoot, ".mcp.json");
      const mcpJson = yield* readJsonRecord(mcpJsonPath);
      items.push(
        ...(yield* mcpItems(ctx, mcpJson?.mcpServers, {
          path: mcpJsonPath,
          mcpScope: "project",
          projectPath: projectRoot,
        })),
      );
    }
    const managedMcpPath = path.join(ctx.managedDir, "managed-mcp.json");
    const managedMcp = yield* readJsonRecord(managedMcpPath);
    items.push(
      ...(yield* mcpItems(ctx, managedMcp?.mcpServers, {
        path: managedMcpPath,
        mcpScope: "managed",
        projectPath: null,
      })),
    );

    const pluginCacheDir = ctx.environment.CLAUDE_CODE_PLUGIN_CACHE_DIR?.trim();
    const pluginsDir = pluginCacheDir
      ? path.resolve(expandHomePath(pluginCacheDir, ctx.home))
      : path.join(ctx.configDir, "plugins");
    const installed = yield* readJsonRecord(path.join(pluginsDir, "installed_plugins.json"));
    const installedPlugins = isRecord(installed?.plugins) ? installed.plugins : {};
    const knownMarketplacesPath = path.join(pluginsDir, "known_marketplaces.json");
    const knownMarketplaces = yield* readJsonRecord(knownMarketplacesPath);
    for (const [name, marketplace] of Object.entries(knownMarketplaces ?? {})) {
      items.push(
        yield* marketplaceItem(
          ctx,
          "user",
          name,
          knownMarketplacesPath,
          isRecord(marketplace) ? marketplace.source : undefined,
        ),
      );
    }

    const managedDropInDir = path.join(ctx.managedDir, "managed-settings.d");
    const managedDropIns = yield* fileSystem
      .readDirectory(managedDropInDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const settingsFiles: ReadonlyArray<{ path: string; scope: MachineConfigScope }> = [
      { path: path.join(ctx.configDir, "settings.json"), scope: "user" },
      { path: path.join(ctx.managedDir, "managed-settings.json"), scope: "managed" },
      ...managedDropIns
        .filter((name) => name.endsWith(".json") && !name.startsWith("."))
        .toSorted()
        .map((name) => ({ path: path.join(managedDropInDir, name), scope: "managed" as const })),
    ];
    for (const source of settingsFiles) {
      const settings = yield* readJsonRecord(source.path);
      if (settings === undefined) continue;
      items.push(...(yield* settingsItems(ctx, settings, source, installedPlugins)));
    }

    for (const candidate of yield* fileCandidates(ctx)) {
      items.push(yield* hashCandidate(candidate));
    }

    return {
      environmentId: yield* environmentIdentity.getEnvironmentId,
      scannedAt: DateTime.formatIso(yield* DateTime.now),
      homeDir: ctx.home,
      claudeConfigDir: ctx.configDir,
      claudeVersion: stringOrNull(claudeJsonValue.lastReleaseNotesSeen),
      items: uniqueIds(items).toSorted((a, b) => compareStrings(a.id, b.id)),
      problems,
    };
  }, provideFileSystem);

  const findCandidate = Effect.fnUntraced(function* (id: string) {
    // Memory items label their project from .claude.json, as a scan does.
    const projectPaths = id.startsWith("memory:")
      ? (yield* readClaudeJson([])).projectPaths
      : new Map<string, string>();
    const ctx = yield* resolveContext(projectPaths);
    const candidate = (yield* fileCandidates(ctx)).find((entry) => entry.draft.id === id);
    if (candidate === undefined) return yield* new ConfigItemNotFoundError({ id });
    return candidate;
  });

  const findItem: ConfigInventory["Service"]["findItem"] = Effect.fn("ConfigInventory.findItem")(
    function* (id) {
      const category = id.slice(0, id.indexOf(":"));
      if (!isMachineConfigCategory(category)) return yield* new ConfigItemNotFoundError({ id });
      if (MACHINE_CONFIG_READABLE_CATEGORIES.has(category)) {
        return yield* hashCandidate(yield* findCandidate(id));
      }
      const scanned = yield* scan({ projectRoots: [] });
      const item = scanned.items.find((candidate) => candidate.id === id);
      if (item === undefined) return yield* new ConfigItemNotFoundError({ id });
      return item;
    },
    provideFileSystem,
  );

  const readSkillDirectory = Effect.fnUntraced(function* (id: string, candidate: FileCandidate) {
    const directory = candidate.directory!;
    const readError = (filePath: string) => (cause: unknown) =>
      new ConfigItemReadError({ id, path: filePath, cause });
    const paths = yield* listFiles(directory, () => true);
    if (paths.length > SKILL_READ_LIMIT_FILES) {
      return yield* new ConfigItemTooLargeError({
        id,
        path: directory,
        sizeBytes: 0,
        limitBytes: SKILL_READ_LIMIT_BYTES,
        fileCount: paths.length,
        limitFiles: SKILL_READ_LIMIT_FILES,
      });
    }
    const files: Array<{ path: string; bytes: Uint8Array; executable: boolean }> = [];
    let sizeBytes = 0;
    for (const filePath of paths) {
      const info = yield* fileSystem.stat(filePath).pipe(Effect.mapError(readError(filePath)));
      sizeBytes += Number(info.size);
      if (sizeBytes > SKILL_READ_LIMIT_BYTES) {
        return yield* new ConfigItemTooLargeError({
          id,
          path: directory,
          sizeBytes,
          limitBytes: SKILL_READ_LIMIT_BYTES,
        });
      }
      const bytes = yield* fileSystem.readFile(filePath).pipe(Effect.mapError(readError(filePath)));
      files.push({
        path: relativeKey(directory, filePath),
        bytes,
        executable: (info.mode & 0o111) !== 0,
      });
    }
    const skillMd = files.find((file) => file.path === "SKILL.md");
    return {
      id,
      path: candidate.path,
      content: skillMd === undefined ? "" : new TextDecoder().decode(skillMd.bytes),
      sizeBytes: files.reduce((total, file) => total + file.bytes.byteLength, 0),
      sha256: yield* directoryDigestOfFiles(files),
      files: files.map((file) => ({
        path: file.path,
        contentBase64: Buffer.from(file.bytes).toString("base64"),
        executable: file.executable,
      })),
    } satisfies MachineConfigItemContent;
  });

  const readItem: ConfigInventory["Service"]["readItem"] = Effect.fn("ConfigInventory.readItem")(
    function* (id) {
      const category = id.slice(0, id.indexOf(":"));
      if (isMachineConfigCategory(category)) {
        if (!MACHINE_CONFIG_READABLE_CATEGORIES.has(category)) {
          return yield* new ConfigItemNotReadableError({ id, category });
        }
      } else {
        return yield* new ConfigItemNotFoundError({ id });
      }
      const candidate = yield* findCandidate(id);
      if (
        candidate.directory !== undefined &&
        candidate.draft.category === "skill" &&
        candidate.draft.scope === "user"
      ) {
        return yield* readSkillDirectory(id, candidate);
      }
      const filePath = candidate.path;
      const info = yield* fileSystem
        .stat(filePath)
        .pipe(Effect.mapError((cause) => new ConfigItemReadError({ id, path: filePath, cause })));
      const sizeBytes = Number(info.size);
      if (sizeBytes > READ_LIMIT_BYTES) {
        return yield* new ConfigItemTooLargeError({
          id,
          path: filePath,
          sizeBytes,
          limitBytes: READ_LIMIT_BYTES,
        });
      }
      const bytes = yield* fileSystem
        .readFile(filePath)
        .pipe(Effect.mapError((cause) => new ConfigItemReadError({ id, path: filePath, cause })));
      return {
        id,
        path: filePath,
        content: new TextDecoder().decode(bytes),
        sizeBytes: bytes.byteLength,
        sha256: yield* sha256(bytes),
      };
    },
    provideFileSystem,
  );

  return ConfigInventory.of({ scan, findItem, readItem });
});

/** Repeated entries (two matcher groups for one event) keep distinct ids: `id#2`. */
function uniqueIds(items: ReadonlyArray<MachineConfigItem>): ReadonlyArray<MachineConfigItem> {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const count = (counts.get(item.id) ?? 0) + 1;
    counts.set(item.id, count);
    return count === 1 ? item : { ...item, id: `${item.id}#${count}` };
  });
}

export const layer = Layer.effect(ConfigInventory, make);
