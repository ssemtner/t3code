import type {
  MachineLocalImportInput,
  MachineLocalImportResult,
  ProjectId,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ClaudeSessionThreads from "./ClaudeSessionThreads.ts";
import {
  claudeProjectDirName,
  importClaudeSession,
  isValidSessionId,
  listClaudeSessionFiles,
  type PathPrefixMapping,
  scanClaudeTranscript,
} from "./ClaudeTranscriptPortability.ts";
import { MachineProjectNotFoundError } from "./MachineSource.ts";

type SessionResult = MachineLocalImportResult["sessions"][number];

const normalize = (value: string) => value.replace(/\/+$/, "") || "/";

const isWithin = (candidate: string, root: string) =>
  candidate === root || candidate.startsWith(root === "/" ? "/" : `${root}/`);

/**
 * Paths to rewrite when a transcript moves to another project folder on the same machine. A
 * session in a different checkout (a worktree, another clone) maps that checkout onto the
 * project's; one in the project's own checkout keeps its paths, which stay valid here.
 */
export function localTranscriptMappings(input: {
  readonly sessionCwd: string | null;
  readonly sessionCheckoutRoot: string | null;
  readonly projectRoot: string;
  readonly projectCheckoutRoot: string | null;
  readonly sourceProjectDir: string;
  readonly destinationProjectDir: string;
}): ReadonlyArray<PathPrefixMapping> {
  const mappings: Array<PathPrefixMapping> = [
    { from: normalize(input.sourceProjectDir), to: normalize(input.destinationProjectDir) },
  ];
  const projectRoot = normalize(input.projectRoot);
  if (input.sessionCheckoutRoot !== null && input.projectCheckoutRoot !== null) {
    mappings.push({
      from: normalize(input.sessionCheckoutRoot),
      to: normalize(input.projectCheckoutRoot),
    });
  } else if (input.sessionCwd !== null && !isWithin(normalize(input.sessionCwd), projectRoot)) {
    // The session's folder is gone or not a checkout, so only its own path can be mapped.
    mappings.push({ from: normalize(input.sessionCwd), to: projectRoot });
  }
  return mappings.filter((mapping) => mapping.from !== mapping.to);
}

export class MachineLocalImport extends Context.Service<
  MachineLocalImport,
  {
    /** Opens Claude sessions already on this machine as threads in one of its projects. */
    readonly importSessions: (
      input: MachineLocalImportInput,
    ) => Effect.Effect<
      MachineLocalImportResult,
      | MachineProjectNotFoundError
      | ClaudeSessionThreads.MachineClaudeUnavailableError
      | ProjectStore.ProjectStoreV2Error
      | ServerSettingsError
    >;
  }
>()("t3/machines/MachineLocalImport") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sessionThreads = yield* ClaudeSessionThreads.make;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* (yield* VcsDriverRegistry.VcsDriverRegistry).get("git").pipe(Effect.orDie);

  const checkoutRoot = (cwd: string) =>
    git
      .execute({
        operation: "MachineLocalImport.checkoutRoot",
        cwd,
        args: ["rev-parse", "--show-toplevel"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) =>
          result.exitCode === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : null,
        ),
        Effect.orElseSucceed(() => null),
      );

  const importSession = Effect.fn("MachineLocalImport.importSession")(function* (
    project: { readonly projectId: ProjectId; readonly root: string },
    claude: ClaudeSessionThreads.ClaudeInstance,
    sessionId: string,
  ) {
    const notFound: SessionResult = { sessionId, threadId: null, status: "not-found" };
    if (!isValidSessionId(sessionId)) return notFound;
    const listing = yield* listClaudeSessionFiles({ configDir: claude.configDir, sessionId }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.asSome,
      Effect.catchTags({
        ClaudeSessionNotFoundError: () => Effect.succeedNone,
        ClaudeSessionPathError: () => Effect.succeedNone,
        ClaudeTranscriptFileError: () => Effect.succeedNone,
      }),
    );
    if (Option.isNone(listing)) return notFound;
    const { projectDir: sourceProjectDir, files } = listing.value;
    const destinationProjectDir = path.join(
      claude.configDir,
      "projects",
      claudeProjectDirName(project.root),
    );

    // Copied, never moved: the terminal session keeps its transcript where it was.
    const copy = Effect.gen(function* () {
      const scan = yield* scanClaudeTranscript(
        path.join(sourceProjectDir, `${sessionId}.jsonl`),
        [],
      );
      const [sessionCheckoutRoot, projectCheckoutRoot] =
        scan.firstCwd === null
          ? [null, null]
          : yield* Effect.all([checkoutRoot(scan.firstCwd), checkoutRoot(project.root)]);
      const placed = yield* importClaudeSession({
        sourceDir: sourceProjectDir,
        sessionId,
        files: files.map((file) => file.relativePath),
        configDir: claude.configDir,
        cwd: project.root,
        mappings: localTranscriptMappings({
          sessionCwd: scan.firstCwd,
          sessionCheckoutRoot,
          projectRoot: project.root,
          projectCheckoutRoot,
          sourceProjectDir,
          destinationProjectDir,
        }),
        onExisting: "replace-if-prefix",
      });
      return Option.some({
        projectDir: placed.projectDir,
        changed: placed.files.some((file) => file.status !== "unchanged"),
      });
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchTags({ ClaudeSessionConflictError: () => Effect.succeedNone }),
    );

    const outcome = yield* sessionThreads.openAsThread({
      projectId: project.projectId,
      root: project.root,
      claude,
      sessionId,
      place:
        sourceProjectDir === destinationProjectDir
          ? Effect.succeedSome({ projectDir: destinationProjectDir, changed: false })
          : copy,
    });
    switch (outcome.kind) {
      case "imported":
        return {
          sessionId,
          threadId: outcome.threadId,
          status: "imported",
        } satisfies SessionResult;
      case "updated":
      case "existing":
      case "owned-elsewhere":
        return {
          sessionId,
          threadId: outcome.threadId,
          status: "existing-thread",
        } satisfies SessionResult;
      case "transcript-conflict":
        return {
          sessionId,
          threadId: outcome.threadId,
          status: "failed",
          reason:
            "The project's folder already holds a different copy of this session, so it was left alone.",
        } satisfies SessionResult;
      case "failed":
        return {
          sessionId,
          threadId: null,
          status: "failed",
          reason: outcome.reason,
        } satisfies SessionResult;
    }
  });

  const importSessions: MachineLocalImport["Service"]["importSessions"] = Effect.fn(
    "MachineLocalImport.importSessions",
  )(function* (input) {
    const shell = yield* projects.getShell(input.projectId);
    if (Option.isNone(shell)) {
      return yield* new MachineProjectNotFoundError({ projectId: input.projectId });
    }
    const project = { projectId: shell.value.id, root: shell.value.workspaceRoot };
    const claude = yield* sessionThreads.resolveClaude(undefined);
    const sessions = yield* Effect.forEach([...new Set(input.sessionIds)], (sessionId) =>
      importSession(project, claude, sessionId),
    );
    return { projectId: project.projectId, sessions } satisfies MachineLocalImportResult;
  });

  return MachineLocalImport.of({ importSessions });
});

export const layer = Layer.effect(MachineLocalImport, make);
