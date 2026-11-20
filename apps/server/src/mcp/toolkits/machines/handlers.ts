import { type MachineConfigItem, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ConfigInventory from "../../../machines/ConfigInventory.ts";
import * as MachineLocalImport from "../../../machines/MachineLocalImport.ts";
import * as MachineReceiver from "../../../machines/MachineReceiver.ts";
import * as MachineSource from "../../../machines/MachineSource.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MachinesToolkit } from "./tools.ts";

// A forwarded tool call that stays silent for about 100 s is dropped by T3 Connect.
const WAIT_MS = 45_000;

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

/** Machine errors carry user-safe messages; anything else is not shown to the agent. */
const mapError = (error: { readonly _tag: string; readonly message: string }) => {
  switch (error._tag) {
    case "MachineProjectNotFoundError":
    case "MachineWorktreeNotFoundError":
    case "MachineNotRepositoryError":
    case "MachineTransferNotFoundError":
    case "MachineNoMatchingProjectError":
    case "MachineAmbiguousProjectError":
    case "MachineUnrelatedProjectError":
    case "MachineTransferConflictError":
      return failure("invalid_request", error.message);
    case "MachineClaudeUnavailableError":
      return failure("provider_unavailable", error.message);
    case "MachineSourceUnavailableError":
    case "MachineUndoUnavailableError":
    case "MachineCheckoutBusyError":
    case "MachineManifestInvalidError":
      return failure("orchestration_error", error.message);
    default:
      return failure("orchestration_error", "The operation could not be completed.");
  }
};

/** Mirrors `MachineConfigApply.destinationOf`: what a copy-config step can write. */
const isCopyableItem = (item: MachineConfigItem) => {
  switch (item.category) {
    case "instructions":
    case "rule":
    case "agent":
    case "command":
    case "output-style":
      return item.scope === "user";
    case "skill":
      return item.scope === "user" && item.name !== "synced";
    case "memory":
      return item.scope === "project";
    default:
      return false;
  }
};

const callerThread = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  return scope.thread === undefined ? {} : { callerThreadId: scope.thread.threadId };
});

export const layer = McpToolAccess.toLayer(MachinesToolkit, {
  t3_machines_survey: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const source = yield* MachineSource.MachineSource;
      return yield* source.survey(input).pipe(Effect.mapError(mapError));
    }),
  ),
  t3_machines_config: McpToolAccess.reads(({ categories }) =>
    Effect.gen(function* () {
      const inventory = yield* ConfigInventory.ConfigInventory;
      const scanned = yield* inventory.scan({ projectRoots: [] });
      const wanted = categories === undefined ? null : new Set(categories);
      return {
        homeDir: scanned.homeDir,
        claudeConfigDir: scanned.claudeConfigDir,
        items: scanned.items
          .filter((item) => wanted === null || wanted.has(item.category))
          .map((item) => ({
            id: item.id,
            category: item.category,
            scope: item.scope,
            name: item.name,
            path: item.path,
            project: item.project,
            sha256: item.sha256,
            modifiedAt: item.modifiedAt,
            sizeBytes: item.sizeBytes,
            ...(item.category === "skill" ? { fileCount: item.fileCount } : {}),
            copyable: isCopyableItem(item),
          })),
      };
    }),
  ),
  t3_machines_receive: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const receiver = yield* MachineReceiver.MachineReceiver;
      const { sourceEnvironmentId, sourceProjectId, ...rest } = input;
      const onlyTransferId =
        input.transferId !== undefined && Object.keys(input).every((key) => key === "transferId");
      if (onlyTransferId && input.transferId !== undefined) {
        return yield* receiver
          .report({ transferId: input.transferId, waitMs: WAIT_MS })
          .pipe(Effect.mapError(mapError));
      }
      if (sourceEnvironmentId === undefined || sourceProjectId === undefined)
        return yield* failure(
          "invalid_request",
          "`sourceEnvironmentId` and `sourceProjectId` are required unless only `transferId` is given.",
        );
      return yield* receiver
        .receive({
          ...rest,
          sourceEnvironmentId,
          sourceProjectId,
          ...(yield* callerThread),
          waitMs: WAIT_MS,
        })
        .pipe(Effect.mapError(mapError));
    }),
  ),
  t3_machines_import_local: McpToolAccess.writesEnvironment(({ projectId, sessionIds }) =>
    Effect.gen(function* () {
      const localImport = yield* MachineLocalImport.MachineLocalImport;
      return yield* localImport
        .importSessions({ projectId, sessionIds })
        .pipe(Effect.mapError(mapError));
    }),
  ),
  t3_machines_undo: McpToolAccess.writesEnvironment(({ transferId }) =>
    Effect.gen(function* () {
      const receiver = yield* MachineReceiver.MachineReceiver;
      return yield* receiver
        .undo({ transferId, ...(yield* callerThread) })
        .pipe(Effect.mapError(mapError));
    }),
  ),
});
