import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  EnvironmentHttpApi,
  type EnvironmentInternalError,
  EnvironmentResourceNotFoundError,
  isMachineRequestRefusedError,
  type MachineRefusalCode,
  MachineRequestRefusedError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Schema from "effect/Schema";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ConfigInventory from "./ConfigInventory.ts";
import * as MachineLocalImport from "./MachineLocalImport.ts";
import * as MachineReceiver from "./MachineReceiver.ts";
import * as MachineSource from "./MachineSource.ts";
import * as MachineThreadMoves from "./MachineThreadMoves.ts";
import * as WorkingTreeSnapshot from "./WorkingTreeSnapshot.ts";

const RECEIVE_WAIT_MS = 3_000;

const refused =
  (code: MachineRefusalCode) =>
  (error: { readonly message: string }): Effect.Effect<never, MachineRequestRefusedError> =>
    Effect.fail(new MachineRequestRefusedError({ code, message: error.message }));

const isEnvironmentResourceNotFoundError = Schema.is(EnvironmentResourceNotFoundError);

// Refusals mapped earlier in the pipeline pass; anything else is an internal failure.
const failUnlessRefused = (
  cause: unknown,
): Effect.Effect<never, MachineRequestRefusedError | EnvironmentInternalError> =>
  isMachineRequestRefusedError(cause)
    ? Effect.fail(cause)
    : failEnvironmentInternal("internal_error", cause);

const failUnlessNotFound = (
  cause: unknown,
): Effect.Effect<never, EnvironmentResourceNotFoundError | EnvironmentInternalError> =>
  isEnvironmentResourceNotFoundError(cause)
    ? Effect.fail(cause)
    : failEnvironmentInternal("internal_error", cause);

const threadNotFound = () => failEnvironmentNotFound("thread_not_found");

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "machines",
  Effect.fnUntraced(function* (handlers) {
    const source = yield* MachineSource.MachineSource;
    const receiver = yield* MachineReceiver.MachineReceiver;
    const localImport = yield* MachineLocalImport.MachineLocalImport;
    const snapshots = yield* WorkingTreeSnapshot.WorkingTreeSnapshot;
    const moves = yield* MachineThreadMoves.MachineThreadMoves;
    const inventory = yield* ConfigInventory.ConfigInventory;

    const checkoutErrors = {
      MachineProjectNotFoundError: refused("project-not-found"),
      MachineWorktreeNotFoundError: refused("worktree-not-found"),
      MachineNotRepositoryError: refused("not-repository"),
    };

    return handlers
      .handle(
        "survey",
        Effect.fn("environment.machines.survey")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* source
            .survey(args.payload)
            .pipe(
              Effect.catchTags({ MachineProjectNotFoundError: refused("project-not-found") }),
              Effect.catch(failUnlessRefused),
            );
        }),
      )
      .handle(
        "checkout",
        Effect.fn("environment.machines.checkout")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* source.describeCheckout(args.payload).pipe(
            Effect.flatMap((identity) =>
              snapshots
                .describeCheckout(identity.checkoutRoot)
                .pipe(Effect.map((description) => ({ identity, description }))),
            ),
            Effect.catchTags(checkoutErrors),
            Effect.catch(failUnlessRefused),
          );
        }),
      )
      .handle(
        "receive",
        Effect.fn("environment.machines.receive")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* requireEnvironmentScope(AuthSourceControlWriteScope);
          return yield* receiver.receive({ ...args.payload, waitMs: RECEIVE_WAIT_MS }).pipe(
            Effect.catchTags({
              MachineSourceUnavailableError: (error) =>
                refused(error.linkReason === "disabled" ? "links-disabled" : "source-unavailable")(
                  error,
                ),
              MachineNoMatchingProjectError: refused("no-matching-project"),
              MachineAmbiguousProjectError: (error) =>
                Effect.fail(
                  new MachineRequestRefusedError({
                    code: "ambiguous-project",
                    message: error.message,
                    candidates: error.candidates,
                  }),
                ),
              MachineUnrelatedProjectError: refused("unrelated-project"),
              MachineClaudeUnavailableError: refused("claude-unavailable"),
              MachineTransferNotFoundError: refused("transfer-not-found"),
            }),
            Effect.catch(failUnlessRefused),
          );
        }),
      )
      .handle(
        "importLocal",
        Effect.fn("environment.machines.importLocal")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* localImport.importSessions(args.payload).pipe(
            Effect.catchTags({
              MachineProjectNotFoundError: refused("project-not-found"),
              MachineClaudeUnavailableError: refused("claude-unavailable"),
            }),
            Effect.catch(failUnlessRefused),
          );
        }),
      )
      .handle(
        "transferReport",
        Effect.fn("environment.machines.transferReport")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* receiver
            .report({
              transferId: args.params.transferId,
              waitMs: args.query.wait === "1" ? RECEIVE_WAIT_MS : 0,
            })
            .pipe(
              Effect.catchTags({ MachineTransferNotFoundError: refused("transfer-not-found") }),
              Effect.catch(failUnlessRefused),
            );
        }),
      )
      .handle(
        "undo",
        Effect.fn("environment.machines.undo")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSourceControlWriteScope);
          return yield* receiver.undo({ transferId: args.params.transferId }).pipe(
            Effect.catchTags({
              MachineTransferNotFoundError: refused("transfer-not-found"),
              MachineUndoUnavailableError: refused("undo-unavailable"),
              MachineCheckoutBusyError: refused("checkout-busy"),
            }),
            Effect.catch(failUnlessRefused),
          );
        }),
      )
      .handle(
        "moveSource",
        Effect.fn("environment.machines.moveSource")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* moves
            .describe(args.params.threadId)
            .pipe(
              Effect.catchTags({ MachineThreadNotFoundError: threadNotFound }),
              Effect.catch(failUnlessNotFound),
            );
        }),
      )
      .handle(
        "markMoved",
        Effect.fn("environment.machines.markMoved")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* moves
            .markMoved({ ...args.payload, threadId: args.params.threadId })
            .pipe(
              Effect.catchTags({ MachineThreadNotFoundError: threadNotFound }),
              Effect.catch(failUnlessNotFound),
            );
        }),
      )
      .handle(
        "moves",
        Effect.fn("environment.machines.moves")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* moves.list.pipe(
            Effect.map((list) => ({ moves: list })),
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      )
      .handle(
        "inventory",
        Effect.fn("environment.machines.inventory")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* inventory.scan({ projectRoots: args.payload.projectRoots ?? [] });
        }),
      );
  }),
);
