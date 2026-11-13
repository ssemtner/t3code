import {
  CommandId,
  type MachineMarkMovedInput,
  MachineThreadMove,
  type MachineThreadMoveSource,
  ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

export class MachineThreadNotFoundError extends Schema.TaggedError<MachineThreadNotFoundError>()(
  "MachineThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found on this machine.`;
  }
}

const CLAUDE_DRIVER = "claudeAgent";

/** `moves.json`: the source thread id to where it went. */
const MovesFile = Schema.Record(Schema.String, MachineThreadMove);
const MovesFileJson = Schema.fromJsonString(MovesFile);
const decodeMoves = Schema.decodeUnknownEffect(MovesFileJson);
const encodeMoves = Schema.encodeEffect(MovesFileJson);

type DispatchError = Effect.Error<
  ReturnType<ThreadManagementService.ThreadManagementService["Service"]["dispatch"]>
>;

export class MachineThreadMoves extends Context.Service<
  MachineThreadMoves,
  {
    /** What moving the thread to another machine would carry, or why it cannot move. */
    readonly describe: (
      threadId: ThreadId,
    ) => Effect.Effect<
      MachineThreadMoveSource,
      | MachineThreadNotFoundError
      | Orchestrator.OrchestratorV2Error
      | ProjectStore.ProjectStoreV2Error
    >;
    /** Archives the moved thread here and records where its copy lives. */
    readonly markMoved: (
      input: MachineMarkMovedInput & { readonly threadId: ThreadId },
    ) => Effect.Effect<
      MachineThreadMove,
      | MachineThreadNotFoundError
      | Orchestrator.OrchestratorV2Error
      | DispatchError
      | PlatformError.PlatformError
      | Schema.SchemaError
    >;
    readonly list: Effect.Effect<
      ReadonlyArray<MachineThreadMove>,
      PlatformError.PlatformError | Schema.SchemaError
    >;
  }
>()("t3/machines/MachineThreadMoves") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const movesPath = path.join(stateDir, "machines", "moves.json");
  const writes = yield* Semaphore.make(1);

  const requireShell = Effect.fn("MachineThreadMoves.requireShell")(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId);
    if (shell === null || shell.deletedAt !== null) {
      return yield* new MachineThreadNotFoundError({ threadId });
    }
    return shell;
  });

  const readMoves = Effect.fn("MachineThreadMoves.readMoves")(function* () {
    if (!(yield* fileSystem.exists(movesPath))) return {};
    return yield* decodeMoves(yield* fileSystem.readFileString(movesPath));
  });

  const describe: MachineThreadMoves["Service"]["describe"] = Effect.fn(
    "MachineThreadMoves.describe",
  )(function* (threadId) {
    const shell = yield* requireShell(threadId);
    const project = yield* projects.getShell(shell.projectId);
    if (Option.isNone(project)) return yield* new MachineThreadNotFoundError({ threadId });
    const { providerThreads } = yield* threads.getThreadRecords(threadId, ["providerThreads"]);
    const providerThread = providerThreads.find(
      (candidate) => candidate.id === shell.activeProviderThreadId,
    );
    const driver = providerThread?.driver ?? null;
    const sessionId = providerThread?.nativeThreadRef?.nativeId || null;
    const idle =
      shell.activeRunId === null &&
      (shell.pendingBackgroundTasks ?? []).length === 0 &&
      shell.pendingRuntimeRequest === null;
    return {
      threadId,
      sessionId,
      driver,
      projectId: shell.projectId,
      worktreePath: shell.worktreePath,
      checkoutRoot: shell.worktreePath ?? project.value.workspaceRoot,
      idle,
      refusal:
        driver !== null && driver !== CLAUDE_DRIVER
          ? "not-claude"
          : sessionId === null
            ? "no-session"
            : idle
              ? null
              : "thread-busy",
    };
  });

  const markMoved: MachineThreadMoves["Service"]["markMoved"] = Effect.fn(
    "MachineThreadMoves.markMoved",
  )(function* (input) {
    const shell = yield* requireShell(input.threadId);
    const move: MachineThreadMove = {
      threadId: input.threadId,
      destinationEnvironmentId: input.destinationEnvironmentId,
      destinationThreadId: input.destinationThreadId,
      transferId: input.transferId,
      movedAt: DateTime.formatIso(yield* DateTime.now),
    };
    // The pointer lands first: a failed archive is retried by marking again.
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const moves = yield* readMoves();
        const contents = yield* encodeMoves({ ...moves, [input.threadId]: move });
        yield* writeFileStringAtomically({ filePath: movesPath, contents }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
      }),
    );
    if (shell.archivedAt === null) {
      const uuid = yield* random.uuidV4().pipe(Effect.orDie);
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`server:machines-move:${input.threadId}:${uuid}`),
        threadId: input.threadId,
      });
    }
    return move;
  });

  const list: MachineThreadMoves["Service"]["list"] = readMoves().pipe(
    Effect.map((moves) => Object.values(moves)),
    Effect.withSpan("MachineThreadMoves.list"),
  );

  return MachineThreadMoves.of({ describe, markMoved, list });
});

export const layer = Layer.effect(MachineThreadMoves, make);
