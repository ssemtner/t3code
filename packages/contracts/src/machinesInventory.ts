import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";

/** Closed: a new kind of Claude config is a new literal here plus its scanner. */
export const MachineConfigCategory = Schema.Literals([
  // `mcpServers` of .claude.json (user, and per-project local), a project's .mcp.json, managed-mcp.json.
  "mcp-server",
  // The user and managed CLAUDE.md, and files the user one imports with `@path`.
  "instructions",
  // A .md file under the user or managed `rules` directory.
  "rule",
  // A .md file under the config dir's `agents`, `commands` or `output-styles`.
  "agent",
  "command",
  // A user skill directory, or a skill of an enabled plugin.
  "skill",
  // From settings files: a `hooks` matcher group, a `permissions` entry, an `env` name,
  // an `enabledPlugins` entry.
  "hook",
  "permission",
  "env",
  "plugin",
  // known_marketplaces.json, or a managed `extraKnownMarketplaces` entry.
  "marketplace",
  // One file of a project's auto-memory directory, `projects/<encoded cwd>/memory`.
  "memory",
  "output-style",
]);
export type MachineConfigCategory = typeof MachineConfigCategory.Type;

/** Categories whose content `readItem` returns. MCP and settings entries can hold secrets. */
export const MACHINE_CONFIG_READABLE_CATEGORIES: ReadonlySet<MachineConfigCategory> = new Set([
  "instructions",
  "rule",
  "agent",
  "command",
  "skill",
  "memory",
  "output-style",
]);

export const MachineConfigScope = Schema.Literals(["user", "project", "plugin", "managed"]);
export type MachineConfigScope = typeof MachineConfigScope.Type;

const itemFields = {
  /**
   * Equal for the same logical thing on two machines: `<category>:<scope>:<key>`, where the key is
   * relative to the config dir or home, or a name. Project keys come from the home-relative project
   * path, lowercased, so `~/Developer/x` and `~/developer/x` match.
   */
  id: Schema.String,
  scope: MachineConfigScope,
  name: Schema.String,
  /** Absolute and machine-specific; for display only. */
  path: Schema.String,
  /** Home-relative project path (or Claude's encoded project folder) for project-bound items. */
  project: Schema.NullOr(Schema.String),
  sizeBytes: NonNegativeInt,
  /**
   * Over the content that matters, with no machine-specific parts: file bytes, a skill's whole
   * directory, or the canonical JSON of a config entry with the home directory written as `~`.
   */
  sha256: Schema.String,
  /** Null for entries inside a shared file such as `settings.json`. */
  modifiedAt: Schema.NullOr(IsoDateTime),
};

const Description = Schema.NullOr(Schema.String);

export const MachineConfigItem = Schema.Union([
  Schema.Struct({
    ...itemFields,
    category: Schema.Literal("mcp-server"),
    /** Claude's own scope; `local` entries live in `.claude.json` under one project. */
    mcpScope: Schema.Literals(["user", "local", "project", "managed"]),
    transport: Schema.String,
    /** Basename of a stdio server's command. Arguments, env, headers and URLs never leave. */
    command: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    ...itemFields,
    category: Schema.Literal("instructions"),
    /** The id of the file that imports this one. */
    importedBy: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ ...itemFields, category: Schema.Literal("rule") }),
  Schema.Struct({ ...itemFields, category: Schema.Literal("agent"), description: Description }),
  Schema.Struct({ ...itemFields, category: Schema.Literal("command"), description: Description }),
  Schema.Struct({
    ...itemFields,
    category: Schema.Literal("skill"),
    description: Description,
    enabled: Schema.Boolean,
    plugin: Schema.NullOr(Schema.String),
    fileCount: NonNegativeInt,
  }),
  Schema.Struct({
    ...itemFields,
    category: Schema.Literal("hook"),
    event: Schema.String,
    matcher: Schema.NullOr(Schema.String),
    handlerTypes: Schema.Array(Schema.String),
    /** Basenames of command handlers' executables. */
    commands: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    ...itemFields,
    category: Schema.Literal("permission"),
    behavior: Schema.Literals(["allow", "deny", "ask", "additionalDirectory", "defaultMode"]),
    rule: Schema.String,
  }),
  /** The name is the variable name; its value never leaves the machine. */
  Schema.Struct({ ...itemFields, category: Schema.Literal("env") }),
  Schema.Struct({
    ...itemFields,
    category: Schema.Literal("plugin"),
    enabled: Schema.Boolean,
    marketplace: Schema.NullOr(Schema.String),
    version: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    ...itemFields,
    category: Schema.Literal("marketplace"),
    sourceType: Schema.String,
    /** A GitHub repo, a git or URL source's host, or a home-relative local path. */
    location: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    ...itemFields,
    category: Schema.Literal("memory"),
    /** Claude's encoded project folder name under `projects/`. */
    projectDir: Schema.String,
  }),
  Schema.Struct({
    ...itemFields,
    category: Schema.Literal("output-style"),
    description: Description,
  }),
]);
export type MachineConfigItem = typeof MachineConfigItem.Type;

export const MachineConfigProblem = Schema.Struct({
  path: Schema.String,
  reason: Schema.Literals(["unreadable", "malformed"]),
});
export type MachineConfigProblem = typeof MachineConfigProblem.Type;

export const MachineConfigInventory = Schema.Struct({
  environmentId: EnvironmentId,
  scannedAt: IsoDateTime,
  homeDir: Schema.String,
  claudeConfigDir: Schema.String,
  /** The last version `.claude.json` recorded (`lastReleaseNotesSeen`); not a CLI probe. */
  claudeVersion: Schema.NullOr(Schema.String),
  items: Schema.Array(MachineConfigItem),
  /** Config files that exist but could not be read or parsed, so their items are missing. */
  problems: Schema.Array(MachineConfigProblem),
});
export type MachineConfigInventory = typeof MachineConfigInventory.Type;

/** One file of a skill directory, relative to the skill's folder with `/` separators. */
export const MachineConfigItemFile = Schema.Struct({
  path: Schema.String,
  contentBase64: Schema.String,
  executable: Schema.Boolean,
});
export type MachineConfigItemFile = typeof MachineConfigItemFile.Type;

export const MachineConfigItemContent = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  /** The file's text; for a skill, its SKILL.md. */
  content: Schema.String,
  sizeBytes: NonNegativeInt,
  /** The file's sha256, or for a user skill the directory digest the inventory reports. */
  sha256: Schema.String,
  /** Every file of a user skill's directory. Older builds leave it out. */
  files: Schema.optionalKey(Schema.Array(MachineConfigItemFile)),
});
export type MachineConfigItemContent = typeof MachineConfigItemContent.Type;

/** One item of a machine's inventory with its content when its category is readable. */
export const MachineConfigItemRead = Schema.Struct({
  item: MachineConfigItem,
  content: Schema.NullOr(MachineConfigItemContent),
});
export type MachineConfigItemRead = typeof MachineConfigItemRead.Type;
