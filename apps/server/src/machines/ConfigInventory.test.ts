import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type MachineConfigInventory } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { diffInventories } from "@t3tools/shared/machinesInventoryDiff";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { claudeProjectDirName } from "./ClaudeTranscriptPortability.ts";
import * as ConfigInventory from "./ConfigInventory.ts";

const SECRETS = [
  "SECRET_USER_ARG",
  "SECRET_USER_ENV",
  "secret-header.example.com",
  "SECRET_HEADER",
  "SECRET_LOCAL_ARG",
  "SECRET_LOCAL_ENV",
  "SECRET_PROJECT_ARG",
  "SECRET_MANAGED_URL",
  "SECRET_HOOK_ARG",
  "SECRET_SETTINGS_ENV",
  "SECRET_MANAGED_ENV",
  "SECRET_GIT_TOKEN",
];

const json = (value: unknown) => JSON.stringify(value, null, 2);

const writeFiles = Effect.fn("writeFiles")(function* (root: string, files: Record<string, string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  }
});

/** The same Claude setup under `home`, with the project folder spelled `developerDir`. */
const seedMachine = Effect.fn("seedMachine")(function* (
  home: string,
  managedDir: string,
  developerDir: string,
) {
  const project = `${home}/${developerDir}/proj`;
  const installPath = `${home}/.claude/plugins/cache/localmkt/demo/1.2.3`;
  yield* writeFiles(home, {
    ".claude.json": json({
      lastReleaseNotesSeen: "2.1.307",
      mcpServers: {
        ustdio: {
          type: "stdio",
          command: "/opt/bin/npx",
          args: ["-y", "server", "--token", "SECRET_USER_ARG"],
          env: { TOKEN: "SECRET_USER_ENV" },
        },
        uhttp: {
          type: "http",
          url: "https://secret-header.example.com/mcp",
          headers: { Authorization: "Bearer SECRET_HEADER" },
        },
      },
      projects: {
        [project]: {
          allowedTools: [],
          mcpServers: {
            lstdio: {
              type: "stdio",
              command: "node",
              args: [`${home}/servers/x.js`, "SECRET_LOCAL_ARG"],
              env: { KEY: "SECRET_LOCAL_ENV" },
            },
          },
        },
        [`${home}/empty`]: { mcpServers: {} },
      },
    }),
    [`${developerDir}/proj/.mcp.json`]: json({
      mcpServers: { pstdio: { command: "python3", args: ["srv.py", "SECRET_PROJECT_ARG"] } },
    }),
    ".claude/CLAUDE.md": [
      "# Global",
      "See @extra.md and @~/notes/shared.md#section.",
      "Not `@inline.md`, not mail@example.com.",
      "```",
      "@fenced.md",
      "```",
      "<!-- @commented.md -->",
      "@missing.md",
    ].join("\n"),
    ".claude/extra.md": "extra instructions",
    ".claude/inline.md": "never imported",
    ".claude/fenced.md": "never imported",
    "notes/shared.md": "shared notes",
    ".claude/rules/style.md": "use tabs",
    ".claude/rules/lang/ts.md": "---\npaths: ['**/*.ts']\n---\nno any",
    ".claude/agents/reviewer.md": "---\nname: code-reviewer\ndescription: Reviews diffs\n---\nBody",
    ".claude/commands/git/commit.md": "---\ndescription: Commit staged work\n---\nCommit.",
    ".claude/output-styles/terse.md":
      "---\nname: Terse\ndescription: Short answers\n---\nBe brief.",
    ".claude/skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Ship it\n---\nSteps",
    ".claude/skills/deploy/scripts/run.sh": "echo deploy",
    ".claude/skills/deploy/.DS_Store": "machine noise",
    ".claude/settings.json": json({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: `${home}/.claude/hooks/guard.sh --key SECRET_HOOK_ARG` },
            ],
          },
          { matcher: "Bash", hooks: [{ type: "prompt", prompt: "check" }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
      },
      permissions: {
        allow: ["Bash(npm test)", `Read(${home}/notes/**)`],
        deny: ["WebFetch"],
        additionalDirectories: [`${home}/shared`],
        defaultMode: "acceptEdits",
      },
      env: { API_TOKEN: "SECRET_SETTINGS_ENV" },
      enabledPlugins: { "demo@localmkt": true, "off@localmkt": false },
    }),
    ".claude/plugins/installed_plugins.json": json({
      version: 2,
      plugins: { "demo@localmkt": [{ scope: "user", installPath, version: "1.2.3" }] },
    }),
    ".claude/plugins/known_marketplaces.json": json({
      localmkt: { source: { source: "directory", path: `${home}/mkt` } },
      corp: { source: { source: "git", url: "https://SECRET_GIT_TOKEN@git.example.com/m.git" } },
      official: { source: { source: "github", repo: "anthropics/claude-plugins" } },
    }),
    ".claude/plugins/cache/localmkt/demo/1.2.3/.claude-plugin/plugin.json": json({ name: "demo" }),
    ".claude/plugins/cache/localmkt/demo/1.2.3/skills/hello/SKILL.md":
      "---\nname: hello\ndescription: Greets\n---\nHi",
    [`.claude/projects/${claudeProjectDirName(project)}/memory/MEMORY.md`]: "- [topic](topic.md)",
    [`.claude/projects/${claudeProjectDirName(project)}/memory/topic.md`]: "remembered",
    [`.claude/projects/${claudeProjectDirName(project)}/session.jsonl`]: "{}",
  });
  yield* writeFiles(managedDir, {
    "CLAUDE.md": "managed policy",
    ".claude/rules/policy.md": "policy rule",
    "managed-mcp.json": json({
      mcpServers: { corp: { type: "http", url: "https://mcp.example.com/SECRET_MANAGED_URL" } },
    }),
    "managed-settings.json": json({
      permissions: { deny: ["Bash(rm -rf:*)"] },
      extraKnownMarketplaces: {
        corp: { source: { source: "github", repo: "corp/plugins" } },
      },
    }),
    "managed-settings.d/10-env.json": json({ env: { CORP_KEY: "SECRET_MANAGED_ENV" } }),
  });
  return project;
});

const EXPECTED_IDS = [
  "agent:user:reviewer.md",
  "command:user:git/commit.md",
  "env:managed:CORP_KEY",
  "env:user:API_TOKEN",
  "hook:user:PreToolUse:Bash",
  "hook:user:PreToolUse:Bash#2",
  "hook:user:Stop:*",
  "instructions:managed:CLAUDE.md",
  "instructions:user:CLAUDE.md",
  "instructions:user:extra.md",
  "instructions:user:~/notes/shared.md",
  "marketplace:managed:corp",
  "marketplace:user:corp",
  "marketplace:user:localmkt",
  "marketplace:user:official",
  "mcp-server:local:~/developer-proj:lstdio",
  "mcp-server:managed:corp",
  "mcp-server:project:~/developer-proj:pstdio",
  "mcp-server:user:uhttp",
  "mcp-server:user:ustdio",
  "memory:project:~/developer-proj:MEMORY.md",
  "memory:project:~/developer-proj:topic.md",
  "output-style:user:terse.md",
  "permission:managed:deny:Bash(rm -rf:*)",
  "permission:user:additionalDirectory:~/shared",
  "permission:user:allow:Bash(npm test)",
  "permission:user:allow:Read(~/notes/**)",
  "permission:user:defaultMode",
  "permission:user:deny:WebFetch",
  "plugin:user:demo@localmkt",
  "plugin:user:off@localmkt",
  "rule:managed:policy.md",
  "rule:user:lang/ts.md",
  "rule:user:style.md",
  "skill:plugin:demo:hello",
  "skill:user:deploy",
];

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    ConfigInventory.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.succeed(ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env-test")),
          }),
        ),
      ),
    ),
  ),
)("ConfigInventory", (it) => {
  const makeMachine = Effect.fn("makeMachine")(function* (homeSuffix: string, developer: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-config-inventory-" });
    const home = `${root}/${homeSuffix}`;
    const managedDir = `${root}/managed`;
    const project = yield* seedMachine(home, managedDir, developer);
    const inMachine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(ConfigInventory.ClaudeManagedDirectory, managedDir),
      );
    return { home, project, inMachine };
  });

  const scanMachine = Effect.fn("scanMachine")(function* (homeSuffix: string, developer: string) {
    const machine = yield* makeMachine(homeSuffix, developer);
    const inventory = yield* ConfigInventory.ConfigInventory;
    const scanned = yield* machine.inMachine(inventory.scan({ projectRoots: [machine.project] }));
    return { ...machine, scanned };
  });

  const itemById = (inventory: MachineConfigInventory, id: string) =>
    inventory.items.find((item) => item.id === id);

  it.effect("inventories every category of a Claude config dir", () =>
    Effect.gen(function* () {
      const { home, scanned } = yield* scanMachine("Users/ssemtner", "Developer");

      expect(scanned.items.map((item) => item.id)).toEqual(EXPECTED_IDS.toSorted());
      expect(scanned).toMatchObject({
        environmentId: "env-test",
        homeDir: home,
        claudeConfigDir: `${home}/.claude`,
        claudeVersion: "2.1.307",
        problems: [],
      });
      expect(itemById(scanned, "mcp-server:user:ustdio")).toMatchObject({
        transport: "stdio",
        command: "npx",
        mcpScope: "user",
        path: `${home}/.claude.json`,
        modifiedAt: null,
      });
      expect(itemById(scanned, "mcp-server:user:uhttp")).toMatchObject({
        transport: "http",
        command: null,
      });
      expect(itemById(scanned, "mcp-server:project:~/developer-proj:pstdio")).toMatchObject({
        scope: "project",
        mcpScope: "project",
        transport: "stdio",
        command: "python3",
        project: "~/Developer/proj",
      });
      expect(itemById(scanned, "instructions:user:~/notes/shared.md")).toMatchObject({
        importedBy: "instructions:user:CLAUDE.md",
        path: `${home}/notes/shared.md`,
      });
      expect(itemById(scanned, "agent:user:reviewer.md")).toMatchObject({
        name: "code-reviewer",
        description: "Reviews diffs",
      });
      expect(itemById(scanned, "command:user:git/commit.md")).toMatchObject({
        name: "git:commit",
        description: "Commit staged work",
      });
      expect(itemById(scanned, "output-style:user:terse.md")).toMatchObject({ name: "Terse" });
      expect(itemById(scanned, "skill:user:deploy")).toMatchObject({
        scope: "user",
        fileCount: 2,
        enabled: true,
        plugin: null,
      });
      expect(itemById(scanned, "skill:plugin:demo:hello")).toMatchObject({
        scope: "plugin",
        plugin: "demo",
      });
      expect(itemById(scanned, "hook:user:PreToolUse:Bash")).toMatchObject({
        event: "PreToolUse",
        matcher: "Bash",
        handlerTypes: ["command"],
        commands: ["guard.sh"],
      });
      expect(itemById(scanned, "plugin:user:demo@localmkt")).toMatchObject({
        enabled: true,
        marketplace: "localmkt",
        version: "1.2.3",
      });
      expect(itemById(scanned, "plugin:user:off@localmkt")).toMatchObject({
        enabled: false,
        version: null,
      });
      expect(itemById(scanned, "marketplace:user:corp")).toMatchObject({
        sourceType: "git",
        location: "git.example.com",
      });
      expect(itemById(scanned, "marketplace:user:localmkt")).toMatchObject({ location: "~/mkt" });
      expect(itemById(scanned, "memory:project:~/developer-proj:MEMORY.md")).toMatchObject({
        project: "~/Developer/proj",
        projectDir: claudeProjectDirName(`${home}/Developer/proj`),
      });
    }),
  );

  it.effect("never returns MCP or settings secrets, from a scan or a refused read", () =>
    Effect.gen(function* () {
      const { scanned, inMachine } = yield* scanMachine("Users/ssemtner", "Developer");
      const inventory = yield* ConfigInventory.ConfigInventory;
      const refusals = yield* Effect.forEach(
        scanned.items.filter((item) =>
          ["mcp-server", "hook", "permission", "env", "plugin", "marketplace"].includes(
            item.category,
          ),
        ),
        (item) => inMachine(Effect.flip(inventory.readItem(item.id))),
      );

      expect(refusals.map((error) => error._tag)).toEqual(
        refusals.map(() => "ConfigItemNotReadableError"),
      );
      const exposed = JSON.stringify({
        scanned,
        refusals: refusals.map((error) => ({ ...error, message: error.message })),
      });
      for (const secret of SECRETS) expect(exposed).not.toContain(secret);
    }),
  );

  it.effect("reports a malformed settings file by path without quoting it", () =>
    Effect.gen(function* () {
      const { home, inMachine } = yield* makeMachine("Users/ssemtner", "Developer");
      yield* writeFiles(home, {
        ".claude/settings.json": '{ "env": { "API_TOKEN": "SECRET_SETTINGS_ENV" ',
      });
      const inventory = yield* ConfigInventory.ConfigInventory;
      const scanned = yield* inMachine(inventory.scan({ projectRoots: [] }));

      expect(scanned.problems).toEqual([
        { path: `${home}/.claude/settings.json`, reason: "malformed" },
      ]);
      expect(scanned.items.some((item) => item.category === "env" && item.scope === "user")).toBe(
        false,
      );
      expect(JSON.stringify(scanned)).not.toContain("SECRET_SETTINGS_ENV");
    }),
  );

  it.effect("keys items the same on two machines with different homes", () =>
    Effect.gen(function* () {
      const mac = yield* scanMachine("Users/ssemtner", "Developer");
      const linux = yield* scanMachine("home/sjsem", "developer");

      expect(linux.scanned.items.map((item) => item.id)).toEqual(
        mac.scanned.items.map((item) => item.id),
      );
      const diff = diffInventories(mac.scanned, linux.scanned);
      expect(diff.counts).toEqual({
        same: EXPECTED_IDS.length,
        differs: 0,
        "only-a": 0,
        "only-b": 0,
      });
    }),
  );

  it.effect("finds one item as a scan reports it", () =>
    Effect.gen(function* () {
      const { inMachine } = yield* makeMachine("Users/ssemtner", "Developer");
      const inventory = yield* ConfigInventory.ConfigInventory;
      const scanned = yield* inMachine(inventory.scan({ projectRoots: [] }));
      for (const item of scanned.items) {
        expect(yield* inMachine(inventory.findItem(item.id))).toEqual(item);
      }
      expect((yield* Effect.flip(inMachine(inventory.findItem("skill:user:absent"))))._tag).toBe(
        "ConfigItemNotFoundError",
      );
    }),
  );

  it.effect("reads file-backed items and refuses what it cannot serve", () =>
    Effect.gen(function* () {
      const { home, inMachine } = yield* makeMachine("Users/ssemtner", "Developer");
      yield* writeFiles(home, { ".claude/rules/huge.md": "x".repeat(256 * 1024 + 1) });
      yield* (yield* FileSystem.FileSystem).chmod(
        `${home}/.claude/skills/deploy/scripts/run.sh`,
        0o755,
      );
      const inventory = yield* ConfigInventory.ConfigInventory;
      const read = (id: string) => inMachine(inventory.readItem(id));

      expect(yield* read("rule:user:lang/ts.md")).toMatchObject({
        path: `${home}/.claude/rules/lang/ts.md`,
        content: "---\npaths: ['**/*.ts']\n---\nno any",
      });
      const skill = yield* read("skill:user:deploy");
      expect(skill.content).toContain("description: Ship it");
      expect(skill.files).toEqual([
        {
          path: "SKILL.md",
          contentBase64: Buffer.from(
            "---\nname: deploy\ndescription: Ship it\n---\nSteps",
          ).toString("base64"),
          executable: false,
        },
        {
          path: "scripts/run.sh",
          contentBase64: Buffer.from("echo deploy").toString("base64"),
          executable: true,
        },
      ]);
      const scanned = yield* inMachine(inventory.scan({ projectRoots: [] }));
      expect(skill.sha256).toBe(
        scanned.items.find((item) => item.id === "skill:user:deploy")?.sha256,
      );
      expect((yield* read("skill:plugin:demo:hello")).files).toBeUndefined();
      expect((yield* read("memory:project:~/developer-proj:topic.md")).content).toBe("remembered");
      expect((yield* read("instructions:user:~/notes/shared.md")).content).toBe("shared notes");
      expect(yield* Effect.flip(read("rule:user:huge.md"))).toMatchObject({
        _tag: "ConfigItemTooLargeError",
        sizeBytes: 256 * 1024 + 1,
      });
      expect((yield* Effect.flip(read("rule:user:absent.md")))._tag).toBe(
        "ConfigItemNotFoundError",
      );
      expect((yield* Effect.flip(read("instructions:user:inline.md")))._tag).toBe(
        "ConfigItemNotFoundError",
      );
      expect((yield* Effect.flip(read("../../etc/passwd")))._tag).toBe("ConfigItemNotFoundError");
    }),
  );
});

describe("claudeMdImports", () => {
  it.each([
    ["relative and home imports", "Use @a.md and @~/b.md.", ["a.md", "~/b.md."]],
    ["absolute import", "@/etc/x.md", ["/etc/x.md"]],
    ["fragment dropped", "@docs/x.md#part", ["docs/x.md"]],
    ["escaped space", "@my\\ notes.md", ["my notes.md"]],
    ["code span skipped", "`@a.md` @b.md", ["b.md"]],
    ["fenced block skipped", "```md\n@a.md\n```\n@b.md", ["b.md"]],
    ["html comment skipped", "<!-- @a.md --> @b.md", ["b.md"]],
    ["email is not an import", "mail@example.com", []],
    ["scoped package is not an import", "@@scope/pkg @#tag", []],
  ])("%s", (_name, contents, expected) => {
    expect(ConfigInventory.claudeMdImports(contents)).toEqual(expected);
  });
});
