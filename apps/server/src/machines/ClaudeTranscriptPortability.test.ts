import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeProjectDirName,
  discoverClaudeSessions,
  importClaudeSession,
  listClaudeSessionFiles,
  makeTranscriptLineRewriter,
} from "./ClaudeTranscriptPortability.ts";

const LINUX_CWD = "/home/sjsem/developer/robotics/1538_2026_Offseason_Rust";
const MAC_CWD = "/Users/ssemtner/Developer/robotics/1538_2026_Offseason_Rust";
const SESSION_ID = "0b8f5c1e-3d2a-4f6b-9c1d-2e3f4a5b6c7d";

const mappings = [
  { from: "/home/sjsem", to: "/Users/ssemtner" },
  { from: "/home/sjsem/developer/", to: "/Users/ssemtner/Developer" },
];
const rewriteLine = makeTranscriptLineRewriter(mappings);
const rewriteValue = (value: string) =>
  (JSON.parse(rewriteLine(JSON.stringify({ value }))) as { value: string }).value;

const writeFiles = Effect.fn("writeFiles")(function* (root: string, files: Record<string, string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  }
});

const jsonl = (...records: ReadonlyArray<unknown>) =>
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

describe("claudeProjectDirName", () => {
  it("replaces every non-alphanumeric character", () => {
    expect(claudeProjectDirName(LINUX_CWD)).toBe(
      "-home-sjsem-developer-robotics-1538-2026-Offseason-Rust",
    );
  });
});

describe("makeTranscriptLineRewriter", () => {
  it.each([
    ["longest prefix wins", `${LINUX_CWD}/src/main.rs`, `${MAC_CWD}/src/main.rs`],
    ["exact prefix", "/home/sjsem", "/Users/ssemtner"],
    ["dotfile under the shorter prefix", "/home/sjsem/.bashrc", "/Users/ssemtner/.bashrc"],
    ["no match past a segment boundary", "/home/sjsemantic/x", "/home/sjsemantic/x"],
    ["no match inside another path", "/opt/home/sjsem/x", "/opt/home/sjsem/x"],
    [
      "longer prefix fails its boundary, shorter applies",
      "/home/sjsem/developer-old/x",
      "/Users/ssemtner/developer-old/x",
    ],
    [
      "many occurrences in prose and commands",
      'cd /home/sjsem/developer/a && cat "/home/sjsem/b.rs:12" (see /home/sjsem)\n/home/sjsem/c',
      'cd /Users/ssemtner/Developer/a && cat "/Users/ssemtner/b.rs:12" (see /Users/ssemtner)\n/Users/ssemtner/c',
    ],
    [
      "encoded project directory segment",
      "/Users/ssemtner/.claude/projects/-home-sjsem-developer-robotics-1538/abc.jsonl",
      "/Users/ssemtner/.claude/projects/-Users-ssemtner-Developer-robotics-1538/abc.jsonl",
    ],
    ["encoded form respects its boundary", "/x/-home-sjsemantic", "/x/-home-sjsemantic"],
    [
      "escaped quotes and unicode survive",
      'say "hi" é   😀 \\ /home/sjsem/x',
      'say "hi" é   😀 \\ /Users/ssemtner/x',
    ],
  ])("%s", (_name, input, expected) => {
    expect(rewriteValue(input)).toBe(expected);
  });

  it("rewrites nested string values, keeps keys and key order", () => {
    const line = JSON.stringify({
      z: "/home/sjsem/a",
      "/home/sjsem": { y: 1, b: ["/home/sjsem/b", true, null] },
      a: 2,
    });
    expect(rewriteLine(line)).toBe(
      JSON.stringify({
        z: "/Users/ssemtner/a",
        "/home/sjsem": { y: 1, b: ["/Users/ssemtner/b", true, null] },
        a: 2,
      }),
    );
  });

  it.each([
    ["invalid JSON", '{"cwd":"/home/sjsem/x"'],
    ["empty line", ""],
    ["unchanged line with escapes", '{"a":"\\u00e9 \\/ /home/sjsemantic","n":1.0}'],
  ])("passes %s through byte for byte", (_name, line) => {
    expect(rewriteLine(line)).toBe(line);
  });
});

it.layer(NodeServices.layer)("ClaudeTranscriptPortability", (it) => {
  const makeTempDir = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-claude-portability-" });
  });

  const sourceTranscript = `${jsonl(
    { type: "user", cwd: LINUX_CWD, message: { role: "user", content: "fix the build" } },
    {
      type: "assistant",
      cwd: LINUX_CWD,
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: `${LINUX_CWD}/a.rs` } }],
      },
    },
  )}not json /home/sjsem\n\n{"cwd":"/home/sjsem/x"}`;
  const subagentTranscript = jsonl({ cwd: LINUX_CWD, isSidechain: true });

  const seedSourceConfig = Effect.fn("seedSourceConfig")(function* (configDir: string) {
    const project = `projects/${claudeProjectDirName(LINUX_CWD)}`;
    yield* writeFiles(configDir, {
      [`${project}/${SESSION_ID}.jsonl`]: sourceTranscript,
      [`${project}/${SESSION_ID}/subagents/agent-1.jsonl`]: subagentTranscript,
      [`${project}/${SESSION_ID}/tool-results/out.txt`]: `${LINUX_CWD}\n`,
      [`${project}/memory/MEMORY.md`]: "not part of the session",
      [`${project}/other-session.jsonl`]: jsonl({ cwd: LINUX_CWD }),
    });
    return `${configDir}/${project}`;
  });

  it.effect("lists a session's files and fails for an absent one", () =>
    Effect.gen(function* () {
      const configDir = yield* makeTempDir;
      yield* writeFiles(configDir, { "projects/stray-file": "x" });
      const projectDir = yield* seedSourceConfig(configDir);

      const listed = yield* listClaudeSessionFiles({ configDir, sessionId: SESSION_ID });

      expect(listed.projectDir).toBe(projectDir);
      expect(listed.files).toEqual([
        { relativePath: `${SESSION_ID}.jsonl`, size: Buffer.byteLength(sourceTranscript) },
        {
          relativePath: `${SESSION_ID}/subagents/agent-1.jsonl`,
          size: Buffer.byteLength(subagentTranscript),
        },
        { relativePath: `${SESSION_ID}/tool-results/out.txt`, size: LINUX_CWD.length + 1 },
      ]);
      const missing = yield* Effect.flip(
        listClaudeSessionFiles({ configDir, sessionId: "missing-session" }),
      );
      expect(missing._tag).toBe("ClaudeSessionNotFoundError");
    }),
  );

  it.effect("imports a listed session with rewritten transcripts, then is idempotent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const sourceConfig = yield* makeTempDir;
      const destConfig = yield* makeTempDir;
      const sourceDir = yield* seedSourceConfig(sourceConfig);
      const listed = yield* listClaudeSessionFiles({
        configDir: sourceConfig,
        sessionId: SESSION_ID,
      });
      const importSession = importClaudeSession({
        sourceDir,
        sessionId: SESSION_ID,
        files: listed.files.map((file) => file.relativePath),
        configDir: destConfig,
        cwd: MAC_CWD,
        mappings,
      });

      const first = yield* importSession;

      const destDir = `${destConfig}/projects/${claudeProjectDirName(MAC_CWD)}`;
      expect(first.projectDir).toBe(destDir);
      expect(first.files.map((file) => file.status)).toEqual(["written", "written", "written"]);
      const transcript = yield* fileSystem.readFileString(`${destDir}/${SESSION_ID}.jsonl`);
      expect(transcript).toBe(
        `${jsonl(
          { type: "user", cwd: MAC_CWD, message: { role: "user", content: "fix the build" } },
          {
            type: "assistant",
            cwd: MAC_CWD,
            message: {
              content: [
                { type: "tool_use", name: "Read", input: { file_path: `${MAC_CWD}/a.rs` } },
              ],
            },
          },
        )}not json /home/sjsem\n\n{"cwd":"/Users/ssemtner/x"}`,
      );
      expect(transcript.split("\n")).toHaveLength(sourceTranscript.split("\n").length);
      expect(
        yield* fileSystem.readFileString(`${destDir}/${SESSION_ID}/subagents/agent-1.jsonl`),
      ).toBe(jsonl({ cwd: MAC_CWD, isSidechain: true }));
      expect(
        yield* fileSystem.readFileString(`${destDir}/${SESSION_ID}/tool-results/out.txt`),
      ).toBe(`${LINUX_CWD}\n`);

      const second = yield* importSession;
      expect(second.files.map((file) => file.status)).toEqual([
        "unchanged",
        "unchanged",
        "unchanged",
      ]);
    }),
  );

  it.effect("rewrites lines that span stream chunks without splitting characters", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const sourceDir = yield* makeTempDir;
      const destConfig = yield* makeTempDir;
      const line = (index: number) => ({ index, cwd: `${LINUX_CWD}/é😀${"x".repeat(index % 97)}` });
      const records = [
        ...Array.from({ length: 3000 }, (_, index) => line(index)),
        { cwd: "/home/sjsem", blob: "é".repeat(200_000) },
      ];
      yield* writeFiles(sourceDir, { [`${SESSION_ID}.jsonl`]: jsonl(...records) });

      const imported = yield* importClaudeSession({
        sourceDir,
        sessionId: SESSION_ID,
        files: [`${SESSION_ID}.jsonl`],
        configDir: destConfig,
        cwd: MAC_CWD,
        mappings,
      });

      expect(yield* fileSystem.readFileString(`${imported.projectDir}/${SESSION_ID}.jsonl`)).toBe(
        jsonl(
          ...records.map((record) => ({
            ...record,
            cwd: record.cwd.replace(/^\/home\/sjsem\/developer|^\/home\/sjsem/, (prefix) =>
              prefix === "/home/sjsem" ? "/Users/ssemtner" : "/Users/ssemtner/Developer",
            ),
          })),
        ),
      );
    }),
  );

  it.effect("refuses to overwrite a different existing transcript", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const sourceConfig = yield* makeTempDir;
      const destConfig = yield* makeTempDir;
      const sourceDir = yield* seedSourceConfig(sourceConfig);
      const destDir = `${destConfig}/projects/${claudeProjectDirName(MAC_CWD)}`;
      yield* writeFiles(destDir, { [`${SESSION_ID}.jsonl`]: jsonl({ cwd: MAC_CWD }) });

      for (const onExisting of ["fail", "replace-if-prefix"] as const) {
        const error = yield* Effect.flip(
          importClaudeSession({
            sourceDir,
            sessionId: SESSION_ID,
            files: [`${SESSION_ID}.jsonl`, `${SESSION_ID}/subagents/agent-1.jsonl`],
            configDir: destConfig,
            cwd: MAC_CWD,
            mappings,
            onExisting,
          }),
        );

        expect(error).toMatchObject({
          _tag: "ClaudeSessionConflictError",
          sessionId: SESSION_ID,
          relativePath: `${SESSION_ID}.jsonl`,
        });
      }
      expect(yield* fileSystem.readFileString(`${destDir}/${SESSION_ID}.jsonl`)).toBe(
        jsonl({ cwd: MAC_CWD }),
      );
      expect(yield* fileSystem.readDirectory(destDir, { recursive: true })).toEqual(
        expect.not.arrayContaining([expect.stringMatching(/\.tmp$|agent-1\.jsonl$/)]),
      );
    }),
  );

  it.effect("replaces a transcript the incoming one extends and keeps one that extends it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const sourceDir = yield* makeTempDir;
      const destConfig = yield* makeTempDir;
      const transcriptPath = `${sourceDir}/${SESSION_ID}.jsonl`;
      const importSession = (onExisting?: "fail" | "replace-if-prefix") =>
        importClaudeSession({
          sourceDir,
          sessionId: SESSION_ID,
          files: [`${SESSION_ID}.jsonl`],
          configDir: destConfig,
          cwd: MAC_CWD,
          mappings,
          ...(onExisting === undefined ? {} : { onExisting }),
        });
      yield* writeFiles(sourceDir, { [`${SESSION_ID}.jsonl`]: jsonl({ cwd: LINUX_CWD, n: 1 }) });
      const first = yield* importSession();
      const destination = `${first.projectDir}/${SESSION_ID}.jsonl`;
      const longer = jsonl({ cwd: LINUX_CWD, n: 1 }, { cwd: `${LINUX_CWD}/src`, n: 2 });
      yield* fileSystem.writeFileString(transcriptPath, longer);

      expect((yield* Effect.flip(importSession()))._tag).toBe("ClaudeSessionConflictError");
      expect((yield* importSession("replace-if-prefix")).files).toEqual([
        { relativePath: `${SESSION_ID}.jsonl`, size: expect.any(Number), status: "replaced" },
      ]);
      expect(yield* fileSystem.readFileString(destination)).toBe(
        jsonl({ cwd: MAC_CWD, n: 1 }, { cwd: `${MAC_CWD}/src`, n: 2 }),
      );
      expect((yield* importSession("replace-if-prefix")).files[0]?.status).toBe("unchanged");

      // The destination continued past what the source holds: keep it.
      yield* fileSystem.writeFileString(transcriptPath, jsonl({ cwd: LINUX_CWD, n: 1 }));
      expect((yield* Effect.flip(importSession()))._tag).toBe("ClaudeSessionConflictError");
      expect((yield* importSession("replace-if-prefix")).files[0]?.status).toBe("unchanged");
      expect(yield* fileSystem.readFileString(destination)).toBe(
        jsonl({ cwd: MAC_CWD, n: 1 }, { cwd: `${MAC_CWD}/src`, n: 2 }),
      );
    }),
  );

  it.effect.each([
    { name: "parent traversal", relativePath: `${SESSION_ID}/../../escape.jsonl` },
    { name: "an absolute path", relativePath: "/etc/passwd" },
    { name: "another session", relativePath: "other-session.jsonl" },
    { name: "project memory", relativePath: "memory/MEMORY.md" },
  ])("rejects $name", ({ relativePath }) =>
    Effect.gen(function* () {
      const destConfig = yield* makeTempDir;
      const error = yield* Effect.flip(
        importClaudeSession({
          sourceDir: destConfig,
          sessionId: SESSION_ID,
          files: [`${SESSION_ID}.jsonl`, relativePath],
          configDir: destConfig,
          cwd: MAC_CWD,
          mappings,
        }),
      );
      expect(error).toMatchObject({ _tag: "ClaudeSessionPathError", relativePath });
    }),
  );

  it.effect("discovers sessions by the roots they touched, not where they are filed", () =>
    Effect.gen(function* () {
      const configDir = yield* makeTempDir;
      const cppRoot = "/home/sjsem/developer/robotics/1538_2026_Offseason";
      const rustRoot = LINUX_CWD;
      const cppProject = `projects/${claudeProjectDirName(cppRoot)}`;
      const edit = (filePath: string) => ({
        type: "assistant",
        cwd: cppRoot,
        timestamp: "2026-11-02T10:00:00.000Z",
        message: {
          content: [
            { type: "text", text: "editing" },
            { type: "tool_use", name: "Edit", input: { file_path: filePath } },
          ],
        },
      });
      yield* writeFiles(configDir, {
        [`${cppProject}/${SESSION_ID}.jsonl`]: jsonl(
          {
            type: "user",
            cwd: cppRoot,
            timestamp: "2026-11-01T09:00:00.000Z",
            message: { content: "<command-name>/clear</command-name>" },
          },
          {
            type: "user",
            cwd: cppRoot,
            timestamp: "2026-11-01T09:01:00.000Z",
            message: { content: [{ type: "text", text: "Port the swerve code to Rust\nmore" }] },
          },
          edit(`${rustRoot}/src/swerve.rs`),
          edit(`${rustRoot}/src/lib.rs`),
          edit(`${rustRoot}-old/src/lib.rs`),
        ),
        [`${cppProject}/${SESSION_ID}/subagents/agent-1.jsonl`]: jsonl(edit(`${rustRoot}/x.rs`)),
      });

      const oldSession = `${cppProject}/old-session.jsonl`;
      yield* writeFiles(configDir, { [oldSession]: jsonl({ cwd: rustRoot }) });
      const fileSystem = yield* FileSystem.FileSystem;
      const cutoff = Date.parse("2001-01-01T00:00:00.000Z");
      // utimes reads numbers as seconds.
      const beforeSeconds = cutoff / 1000 - 1;
      yield* fileSystem.utimes(`${configDir}/${oldSession}`, beforeSeconds, beforeSeconds);

      const sessions = yield* discoverClaudeSessions({
        configDir,
        roots: [cppRoot, `${rustRoot}/`],
        modifiedAfterMs: cutoff,
      });

      expect(sessions).toEqual([
        expect.objectContaining({
          sessionId: SESSION_ID,
          projectDirName: claudeProjectDirName(cppRoot),
          lineCount: 5,
          firstTimestamp: "2026-11-01T09:00:00.000Z",
          lastTimestamp: "2026-11-02T10:00:00.000Z",
          title: "Port the swerve code to Rust",
          firstCwd: cppRoot,
          roots: [
            { root: cppRoot, cwdLines: 5, toolPaths: 0 },
            { root: rustRoot, cwdLines: 0, toolPaths: 2 },
          ],
        }),
      ]);
      const all = yield* discoverClaudeSessions({ configDir, roots: [cppRoot] });
      expect(all.map((session) => session.sessionId).toSorted()).toEqual(
        [SESSION_ID, "old-session"].toSorted(),
      );
    }),
  );
});
