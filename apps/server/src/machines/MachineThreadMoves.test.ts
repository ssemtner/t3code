import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as MachineThreadMoves from "./MachineThreadMoves.ts";

const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");

const shell = (overrides: Record<string, unknown> = {}) => ({
  id: threadId,
  projectId,
  worktreePath: null,
  activeProviderThreadId: "pt-1",
  activeRunId: null,
  pendingBackgroundTasks: [],
  pendingRuntimeRequest: null,
  archivedAt: null,
  deletedAt: null,
  ...overrides,
});

const providerThread = (driver: string) => ({
  id: "pt-1",
  driver,
  nativeThreadRef: { nativeId: "session-1" },
});

const movesLayer = (input: {
  readonly shell: ReturnType<typeof shell> | null;
  readonly driver?: string;
  readonly dispatched?: Array<OrchestrationV2ServerCommand>;
}) =>
  MachineThreadMoves.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(input.shell as never),
        getThreadRecords: () =>
          Effect.succeed({
            providerThreads: [providerThread(input.driver ?? "claudeAgent")],
          } as never),
        dispatch: (command) =>
          Effect.sync(() => {
            input.dispatched?.push(command);
            return {} as never;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        getShell: () => Effect.succeedSome({ workspaceRoot: "/repo" } as never),
      }),
    ),
  );

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "machine-thread-moves-" }).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
)("MachineThreadMoves", (it) => {
  it.effect("describes whether a thread can move", () =>
    Effect.gen(function* () {
      const describe = (input: Parameters<typeof movesLayer>[0]) =>
        Effect.flatMap(MachineThreadMoves.MachineThreadMoves, (moves) =>
          moves.describe(threadId),
        ).pipe(Effect.provide(movesLayer(input)));

      expect(yield* describe({ shell: shell() })).toMatchObject({
        sessionId: "session-1",
        checkoutRoot: "/repo",
        idle: true,
        refusal: null,
      });
      expect(
        yield* describe({ shell: shell({ worktreePath: "/repo-wt", activeRunId: "run-1" }) }),
      ).toMatchObject({ checkoutRoot: "/repo-wt", idle: false, refusal: "thread-busy" });
      expect(
        yield* describe({ shell: shell({ pendingBackgroundTasks: [{ id: "task" }] }) }),
      ).toMatchObject({ idle: false, refusal: "thread-busy" });
      expect(yield* describe({ shell: shell(), driver: "codex" })).toMatchObject({
        refusal: "not-claude",
      });
      expect(yield* describe({ shell: shell({ activeProviderThreadId: null }) })).toMatchObject({
        sessionId: null,
        driver: null,
        refusal: "no-session",
      });
      const missing = yield* describe({ shell: shell({ deletedAt: "2026-01-01" }) }).pipe(
        Effect.flip,
      );
      expect(missing._tag).toBe("MachineThreadNotFoundError");
    }),
  );

  it.effect("records the move, archives once, and lists it", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationV2ServerCommand> = [];
      const mark = (archivedAt: string | null) =>
        Effect.flatMap(MachineThreadMoves.MachineThreadMoves, (moves) =>
          moves.markMoved({
            threadId,
            destinationEnvironmentId: EnvironmentId.make("env-b"),
            destinationThreadId: ThreadId.make("import:claude:session-1"),
            transferId: "t-1",
          }),
        ).pipe(Effect.provide(movesLayer({ shell: shell({ archivedAt }), dispatched })));

      yield* mark(null);
      // Marking again after the archive landed records the pointer without archiving twice.
      yield* mark("2026-01-01T00:00:00.000Z");
      expect(dispatched).toEqual([expect.objectContaining({ type: "thread.archive", threadId })]);

      const listed = yield* Effect.flatMap(
        MachineThreadMoves.MachineThreadMoves,
        (moves) => moves.list,
      ).pipe(Effect.provide(movesLayer({ shell: null })));
      expect(listed).toEqual([
        expect.objectContaining({
          threadId,
          destinationEnvironmentId: "env-b",
          destinationThreadId: "import:claude:session-1",
          transferId: "t-1",
        }),
      ]);
    }),
  );
});
