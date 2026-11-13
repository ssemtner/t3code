// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Digest hashes whole buffers; transcripts are compared by streaming.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class ClaudeSessionNotFoundError extends Schema.TaggedError<ClaudeSessionNotFoundError>()(
  "ClaudeSessionNotFoundError",
  { sessionId: Schema.String, configDir: Schema.String },
) {
  override get message(): string {
    return `Claude session ${this.sessionId} was not found under ${this.configDir}.`;
  }
}

export class ClaudeSessionPathError extends Schema.TaggedError<ClaudeSessionPathError>()(
  "ClaudeSessionPathError",
  { sessionId: Schema.String, relativePath: Schema.String },
) {
  override get message(): string {
    return `${this.relativePath} is not a file of Claude session ${this.sessionId}.`;
  }
}

export class ClaudeSessionConflictError extends Schema.TaggedError<ClaudeSessionConflictError>()(
  "ClaudeSessionConflictError",
  { sessionId: Schema.String, relativePath: Schema.String },
) {
  override get message(): string {
    return `Claude session ${this.sessionId} already has a different ${this.relativePath} on this machine.`;
  }
}

export class ClaudeTranscriptFileError extends Schema.TaggedError<ClaudeTranscriptFileError>()(
  "ClaudeTranscriptFileError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not access ${this.path}.`;
  }
}

export interface PathPrefixMapping {
  readonly from: string;
  readonly to: string;
}

// Mirrors Claude Code's project directory naming, which works on UTF-16 code units.
export const claudeProjectDirName = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

const SEGMENT_CHAR = String.raw`[\p{L}\p{N}_.~@+%-]`;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, "");

const byLengthDescending = (keys: Iterable<string>) =>
  [...keys].toSorted((left, right) => right.length - left.length);

export function makeTranscriptLineRewriter(
  mappings: ReadonlyArray<PathPrefixMapping>,
): (line: string) => string {
  const raw = new Map<string, string>();
  const encoded = new Map<string, string>();
  for (const mapping of mappings) {
    const from = trimTrailingSlashes(mapping.from);
    if (!from.startsWith("/")) continue;
    const to = trimTrailingSlashes(mapping.to) || "/";
    if (!raw.has(from)) raw.set(from, to);
    const encodedFrom = claudeProjectDirName(from);
    if (!encoded.has(encodedFrom)) encoded.set(encodedFrom, claudeProjectDirName(to));
  }
  if (raw.size === 0) return (line) => line;

  const pattern = new RegExp(
    `(?<!${SEGMENT_CHAR})(${byLengthDescending(raw.keys()).map(escapeRegExp).join("|")})(?!${SEGMENT_CHAR})` +
      `|(?<=^|/)(${byLengthDescending(encoded.keys()).join("|")})(?![A-Za-z0-9])`,
    "gu",
  );
  const needles = [...raw.keys(), ...encoded.keys()].map((key) => JSON.stringify(key).slice(1, -1));
  const rewriteString = (value: string) =>
    value.replace(
      pattern,
      (match, rawMatch: string | undefined, encodedMatch: string | undefined) =>
        rawMatch !== undefined
          ? (raw.get(rawMatch) ?? match)
          : (encoded.get(encodedMatch ?? "") ?? match),
    );

  return (line) => {
    if (!needles.some((needle) => line.includes(needle))) return line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line;
    }
    let changed = false;
    // Mutates the freshly parsed value in place, which keeps key order and own `__proto__` keys.
    const visit = (node: unknown): unknown => {
      if (typeof node === "string") {
        const next = rewriteString(node);
        if (next !== node) changed = true;
        return next;
      }
      if (Array.isArray(node)) {
        for (let index = 0; index < node.length; index++) node[index] = visit(node[index]);
      } else if (typeof node === "object" && node !== null) {
        const record = node as Record<string, unknown>;
        for (const key of Object.keys(record)) record[key] = visit(record[key]);
      }
      return node;
    };
    const rewritten = visit(parsed);
    if (!changed) return line;
    return JSON.stringify(rewritten) + (line.endsWith("\r") ? "\r" : "");
  };
}

// Emits each line with its "\n" so rewriting can reproduce the file byte for byte, including a
// missing final newline. Pending parts are joined only at a newline to keep long lines linear.
const splitLinesKeepingEnds = <E, R>(text: Stream.Stream<string, E, R>) =>
  text.pipe(
    Stream.mapAccum(
      (): Array<string> => [],
      (pending, chunk: string) => {
        let newline = chunk.indexOf("\n");
        if (newline === -1) {
          pending.push(chunk);
          return [pending, []];
        }
        pending.push(chunk.slice(0, newline + 1));
        const lines = [pending.join("")];
        let start = newline + 1;
        while ((newline = chunk.indexOf("\n", start)) !== -1) {
          lines.push(chunk.slice(start, newline + 1));
          start = newline + 1;
        }
        return [start < chunk.length ? [chunk.slice(start)] : [], lines];
      },
      {
        onHalt: (pending) => {
          const rest = pending.join("");
          return rest.length > 0 ? [rest] : [];
        },
      },
    ),
  );

const withoutNewline = (line: string) => (line.endsWith("\n") ? line.slice(0, -1) : line);

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export const isValidSessionId = (sessionId: string) =>
  SESSION_ID_PATTERN.test(sessionId) && !sessionId.includes("..");

export interface ClaudeSessionFile {
  readonly relativePath: string;
  readonly size: number;
}

export const listClaudeSessionFiles = Effect.fn("ClaudeTranscriptPortability.listSessionFiles")(
  function* (input: { readonly configDir: string; readonly sessionId: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { configDir, sessionId } = input;
    if (!isValidSessionId(sessionId)) {
      return yield* new ClaudeSessionPathError({ sessionId, relativePath: `${sessionId}.jsonl` });
    }
    const projectsDir = path.join(configDir, "projects");
    const projects = yield* fileSystem
      .readDirectory(projectsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    let newest: { projectDir: string; size: number; mtimeMs: number } | undefined;
    for (const project of projects) {
      const projectDir = path.join(projectsDir, project);
      const stats = yield* fileSystem
        .stat(path.join(projectDir, `${sessionId}.jsonl`))
        .pipe(Effect.option);
      if (Option.isNone(stats) || stats.value.type !== "File") continue;
      const mtimeMs = Option.match(stats.value.mtime, {
        onNone: () => 0,
        onSome: (d) => d.getTime(),
      });
      if (newest === undefined || mtimeMs > newest.mtimeMs) {
        newest = { projectDir, size: Number(stats.value.size), mtimeMs };
      }
    }
    if (newest === undefined) {
      return yield* new ClaudeSessionNotFoundError({ sessionId, configDir });
    }

    const files: Array<ClaudeSessionFile> = [
      { relativePath: `${sessionId}.jsonl`, size: newest.size },
    ];
    const siblingDir = path.join(newest.projectDir, sessionId);
    const siblingStats = yield* fileSystem.stat(siblingDir).pipe(Effect.option);
    if (Option.isSome(siblingStats) && siblingStats.value.type === "Directory") {
      const entries = yield* fileSystem
        .readDirectory(siblingDir, { recursive: true })
        .pipe(
          Effect.mapError((cause) => new ClaudeTranscriptFileError({ path: siblingDir, cause })),
        );
      const siblings: Array<ClaudeSessionFile> = [];
      for (const entry of entries) {
        const entryPath = path.join(siblingDir, entry);
        // lstat skips symlinks so an export never carries files from outside the session.
        const stats = yield* fileSystem
          .lstat(entryPath)
          .pipe(
            Effect.mapError((cause) => new ClaudeTranscriptFileError({ path: entryPath, cause })),
          );
        if (stats.type !== "File") continue;
        siblings.push({ relativePath: `${sessionId}/${entry}`, size: Number(stats.size) });
      }
      files.push(
        ...siblings.toSorted((left, right) => left.relativePath.localeCompare(right.relativePath)),
      );
    }
    return {
      projectDir: newest.projectDir,
      projectDirName: path.basename(newest.projectDir),
      files,
    };
  },
);

export const isSessionRelativePath = (sessionId: string, relativePath: string) => {
  if (relativePath === `${sessionId}.jsonl`) return true;
  if (!relativePath.startsWith(`${sessionId}/`)) return false;
  return relativePath
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\\"),
    );
};

const fileDigest = (fileSystem: FileSystem.FileSystem, filePath: string, bytesToRead?: number) =>
  fileSystem.stream(filePath, { bytesToRead }).pipe(
    Stream.runFold(
      () => NodeCrypto.createHash("sha256"),
      (hash, chunk: Uint8Array) => hash.update(chunk),
    ),
    Effect.map((hash) => hash.digest("hex")),
  );

export interface ImportedClaudeSessionFile {
  readonly relativePath: string;
  readonly size: number;
  readonly status: "written" | "replaced" | "unchanged";
}

export const importClaudeSession = Effect.fn("ClaudeTranscriptPortability.importSession")(
  function* (input: {
    readonly sourceDir: string;
    readonly sessionId: string;
    readonly files: ReadonlyArray<string>;
    readonly configDir: string;
    readonly cwd: string;
    readonly mappings: ReadonlyArray<PathPrefixMapping>;
    /** `replace-if-prefix` replaces a file the incoming one extends, and keeps one that extends it. */
    readonly onExisting?: "fail" | "replace-if-prefix";
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { sessionId } = input;
    const transcript = `${sessionId}.jsonl`;
    if (!isValidSessionId(sessionId)) {
      return yield* new ClaudeSessionPathError({ sessionId, relativePath: transcript });
    }
    const relativePaths = [...new Set(input.files)];
    for (const relativePath of relativePaths) {
      if (!isSessionRelativePath(sessionId, relativePath)) {
        return yield* new ClaudeSessionPathError({ sessionId, relativePath });
      }
    }
    if (!relativePaths.includes(transcript)) {
      return yield* new ClaudeSessionPathError({ sessionId, relativePath: transcript });
    }

    const projectDir = path.join(input.configDir, "projects", claudeProjectDirName(input.cwd));
    const rewriteLine = makeTranscriptLineRewriter(input.mappings);
    const temporaryFiles: Array<string> = [];
    const pending: Array<{ readonly temporary: string; readonly target: string }> = [];
    const results: Array<ImportedClaudeSessionFile> = [];

    const stage = Effect.fnUntraced(function* (relativePath: string) {
      const source = path.join(input.sourceDir, ...relativePath.split("/"));
      const target = path.join(projectDir, ...relativePath.split("/"));
      const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
      const toFileError = (cause: unknown) =>
        new ClaudeTranscriptFileError({ path: target, cause });
      yield* fileSystem
        .makeDirectory(path.dirname(target), { recursive: true })
        .pipe(Effect.mapError(toFileError));
      temporaryFiles.push(temporary);
      if (relativePath.endsWith(".jsonl")) {
        yield* fileSystem.stream(source).pipe(
          Stream.decodeText,
          splitLinesKeepingEnds,
          Stream.map((line) =>
            line.endsWith("\n") ? `${rewriteLine(line.slice(0, -1))}\n` : rewriteLine(line),
          ),
          Stream.encodeText,
          Stream.run(fileSystem.sink(temporary)),
          Effect.mapError(toFileError),
        );
      } else {
        yield* fileSystem.copyFile(source, temporary).pipe(Effect.mapError(toFileError));
      }
      const size = Number(
        (yield* fileSystem.stat(temporary).pipe(Effect.mapError(toFileError))).size,
      );
      const existing = yield* fileSystem.stat(target).pipe(Effect.option);
      if (Option.isSome(existing)) {
        const existingSize = Number(existing.value.size);
        const sharedSize = Math.min(existingSize, size);
        const isPrefix =
          (existingSize === size || input.onExisting === "replace-if-prefix") &&
          (yield* Effect.all([
            fileDigest(fileSystem, temporary, sharedSize),
            fileDigest(fileSystem, target, sharedSize),
          ]).pipe(
            Effect.map(([staged, current]) => staged === current),
            Effect.mapError(toFileError),
          ));
        if (!isPrefix) return yield* new ClaudeSessionConflictError({ sessionId, relativePath });
        // Equal, or the destination already continued past what the source holds.
        if (existingSize >= size) {
          yield* fileSystem.remove(temporary).pipe(Effect.ignore);
          results.push({ relativePath, size: existingSize, status: "unchanged" });
          return;
        }
        pending.push({ temporary, target });
        results.push({ relativePath, size, status: "replaced" });
        return;
      }
      pending.push({ temporary, target });
      results.push({ relativePath, size, status: "written" });
    });

    // Siblings first and the transcript last, so a session only appears once all its files exist.
    const ordered = [
      ...relativePaths.filter((relativePath) => relativePath !== transcript),
      transcript,
    ];
    yield* Effect.gen(function* () {
      for (const relativePath of ordered) yield* stage(relativePath);
      for (const { temporary, target } of pending) {
        yield* fileSystem
          .rename(temporary, target)
          .pipe(Effect.mapError((cause) => new ClaudeTranscriptFileError({ path: target, cause })));
      }
    }).pipe(
      Effect.onError(() =>
        Effect.forEach(temporaryFiles, (file) => fileSystem.remove(file).pipe(Effect.ignore), {
          discard: true,
        }),
      ),
    );
    return { projectDir, files: results };
  },
);

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;

const stringField = (value: unknown, key: string) => {
  const result = field(value, key);
  return typeof result === "string" ? result : undefined;
};

const TOOL_PATH_FIELDS = ["file_path", "path", "notebook_path"] as const;

function firstUserText(record: unknown): string | undefined {
  if (field(record, "type") !== "user") return undefined;
  if (field(record, "isMeta") === true || field(record, "isSidechain") === true) return undefined;
  if (field(record, "isCompactSummary") === true) return undefined;
  const content = field(field(record, "message"), "content");
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((block) => field(block, "type") === "text")
            .map((block) => stringField(block, "text") ?? "")
            .join("\n")
        : "";
  const trimmed = text.trim();
  // Slash commands and local command output arrive as tagged user text.
  if (trimmed.length === 0 || trimmed.startsWith("<")) return undefined;
  return trimmed.split("\n")[0]?.slice(0, 100).trim() || undefined;
}

export interface ClaudeTranscriptRootHits {
  readonly root: string;
  readonly cwdLines: number;
  readonly toolPaths: number;
}

export interface ClaudeTranscriptScan {
  readonly sessionId: string;
  readonly projectDirName: string;
  readonly filePath: string;
  readonly size: number;
  readonly lineCount: number;
  readonly firstTimestamp: string | null;
  readonly lastTimestamp: string | null;
  readonly title: string | null;
  readonly firstCwd: string | null;
  readonly roots: ReadonlyArray<ClaudeTranscriptRootHits>;
}

const isInsideRoot = (candidate: string, root: string) =>
  candidate === root || candidate.startsWith(root === "/" ? "/" : `${root}/`);

export const scanClaudeTranscript = Effect.fn("ClaudeTranscriptPortability.scanTranscript")(
  function* (filePath: string, roots: ReadonlyArray<string>) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const toFileError = (cause: unknown) =>
      new ClaudeTranscriptFileError({ path: filePath, cause });
    const stats = yield* fileSystem.stat(filePath).pipe(Effect.mapError(toFileError));
    const normalizedRoots = roots.map((root) => trimTrailingSlashes(root) || "/");
    const cwdLines = normalizedRoots.map(() => 0);
    const toolPaths = normalizedRoots.map(() => 0);
    const state = {
      lineCount: 0,
      firstTimestamp: null as string | null,
      lastTimestamp: null as string | null,
      firstCwd: null as string | null,
      firstUserTitle: undefined as string | undefined,
      aiTitle: undefined as string | undefined,
      customTitle: undefined as string | null | undefined,
    };
    const countPath = (counts: Array<number>, candidate: string) => {
      normalizedRoots.forEach((root, index) => {
        if (isInsideRoot(candidate, root)) counts[index] = (counts[index] ?? 0) + 1;
      });
    };

    yield* fileSystem.stream(filePath).pipe(
      Stream.decodeText,
      splitLinesKeepingEnds,
      Stream.runFold(
        () => state,
        (current, rawLine: string) => {
          const line = withoutNewline(rawLine).trim();
          if (line.length === 0) return current;
          current.lineCount += 1;
          let record: unknown;
          try {
            record = JSON.parse(line);
          } catch {
            return current;
          }
          const timestamp = stringField(record, "timestamp");
          if (timestamp !== undefined) {
            current.firstTimestamp ??= timestamp;
            current.lastTimestamp = timestamp;
          }
          const cwd = stringField(record, "cwd");
          if (cwd !== undefined) {
            current.firstCwd ??= cwd;
            countPath(cwdLines, cwd);
          }
          current.firstUserTitle ??= firstUserText(record);
          const aiTitle = stringField(record, "aiTitle")?.trim();
          if (aiTitle) current.aiTitle = aiTitle;
          const customTitle = stringField(record, "customTitle");
          if (customTitle !== undefined) current.customTitle = customTitle.trim() || null;
          const content = field(field(record, "message"), "content");
          if (Array.isArray(content)) {
            for (const block of content) {
              if (field(block, "type") !== "tool_use") continue;
              const toolInput = field(block, "input");
              for (const key of TOOL_PATH_FIELDS) {
                const candidate = stringField(toolInput, key);
                if (candidate?.startsWith("/")) countPath(toolPaths, candidate);
              }
            }
          }
          return current;
        },
      ),
      Effect.mapError(toFileError),
    );

    return {
      sessionId: path.basename(filePath, ".jsonl"),
      projectDirName: path.basename(path.dirname(filePath)),
      filePath,
      size: Number(stats.size),
      lineCount: state.lineCount,
      firstTimestamp: state.firstTimestamp,
      lastTimestamp: state.lastTimestamp,
      title: state.customTitle ?? state.aiTitle ?? state.firstUserTitle ?? null,
      firstCwd: state.firstCwd,
      roots: normalizedRoots.map((root, index) => ({
        root,
        cwdLines: cwdLines[index] ?? 0,
        toolPaths: toolPaths[index] ?? 0,
      })),
    } satisfies ClaudeTranscriptScan;
  },
);

export const discoverClaudeSessions = Effect.fn("ClaudeTranscriptPortability.discoverSessions")(
  function* (input: {
    readonly configDir: string;
    readonly roots: ReadonlyArray<string>;
    readonly modifiedAfterMs?: number;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { modifiedAfterMs } = input;
    const projectsDir = path.join(input.configDir, "projects");
    const projects = yield* fileSystem
      .readDirectory(projectsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const transcripts: Array<string> = [];
    for (const project of projects) {
      const projectDir = path.join(projectsDir, project);
      // Stray files beside the project dirs fail with ENOTDIR.
      const entries = yield* fileSystem
        .readDirectory(projectDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const filePath = path.join(projectDir, entry);
        if (modifiedAfterMs !== undefined) {
          const stats = yield* fileSystem.stat(filePath).pipe(Effect.option);
          const mtimeMs = Option.flatMap(stats, (info) => info.mtime).pipe(
            Option.map((mtime) => mtime.getTime()),
          );
          if (Option.isNone(mtimeMs) || mtimeMs.value < modifiedAfterMs) continue;
        }
        transcripts.push(filePath);
      }
    }
    const scans = yield* Effect.forEach(
      transcripts,
      (filePath) =>
        scanClaudeTranscript(filePath, input.roots).pipe(
          Effect.asSome,
          Effect.catchTags({
            ClaudeTranscriptFileError: () =>
              Effect.logWarning("machines.claude-transcript-scan-failed", { filePath }).pipe(
                Effect.as(Option.none<ClaudeTranscriptScan>()),
              ),
          }),
        ),
      { concurrency: 4 },
    );
    return scans.flatMap(Option.toArray);
  },
);
