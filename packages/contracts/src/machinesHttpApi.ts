import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
// Type-only: environmentHttp.ts imports this module to add the group.
import type {
  EnvironmentAuthenticatedAuth,
  EnvironmentInternalError,
  EnvironmentResourceNotFoundError,
  EnvironmentScopeRequiredError,
} from "./environmentHttp.ts";
import {
  MachineCheckoutDetail,
  MachineCheckoutInput,
  MachineInventoryInput,
  MachineMarkMovedInput,
  MachineReceiveInput,
  MachineRequestRefusedError,
  MachineSurvey,
  MachineSurveyInput,
  MachineThreadMove,
  MachineThreadMoveList,
  MachineThreadMoveSource,
  MachineTransferReport,
} from "./machines.ts";
import { MachineConfigInventory } from "./machinesInventory.ts";

const Headers = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});
const TransferParams = Schema.Struct({ transferId: TrimmedNonEmptyString });
const ThreadParams = Schema.Struct({ threadId: ThreadId });

/** The client-facing machines routes; peer-to-peer transfer routes live outside this API. */
export const makeMachinesHttpApiGroup = (
  auth: typeof EnvironmentAuthenticatedAuth,
  errors: {
    readonly scope: typeof EnvironmentScopeRequiredError;
    readonly notFound: typeof EnvironmentResourceNotFoundError;
    readonly internal: typeof EnvironmentInternalError;
  },
) => {
  const error = [errors.scope, MachineRequestRefusedError, errors.internal];
  const threadError = [...error, errors.notFound];
  return HttpApiGroup.make("machines")
    .add(
      HttpApiEndpoint.post("survey", "/api/machines/ui/survey", {
        headers: Headers,
        payload: MachineSurveyInput,
        success: MachineSurvey,
        error,
      }).middleware(auth),
    )
    .add(
      HttpApiEndpoint.post("checkout", "/api/machines/ui/checkout", {
        headers: Headers,
        payload: MachineCheckoutInput,
        success: MachineCheckoutDetail,
        error,
      }).middleware(auth),
    )
    .add(
      HttpApiEndpoint.post("receive", "/api/machines/ui/receive", {
        headers: Headers,
        payload: MachineReceiveInput,
        success: MachineTransferReport,
        error,
      }).middleware(auth),
    )
    .add(
      HttpApiEndpoint.get("transferReport", "/api/machines/ui/transfers/:transferId", {
        headers: Headers,
        params: TransferParams,
        // Present: hold the answer briefly while the transfer runs, so polling stays cheap.
        query: { wait: Schema.optionalKey(Schema.Literal("1")) },
        success: MachineTransferReport,
        error,
      }).middleware(auth),
    )
    .add(
      HttpApiEndpoint.post("undo", "/api/machines/ui/transfers/:transferId/undo", {
        headers: Headers,
        params: TransferParams,
        success: MachineTransferReport,
        error,
      }).middleware(auth),
    )
    .add(
      HttpApiEndpoint.get("moveSource", "/api/machines/ui/threads/:threadId/move-source", {
        headers: Headers,
        params: ThreadParams,
        success: MachineThreadMoveSource,
        error: threadError,
      }).middleware(auth),
    )
    .add(
      HttpApiEndpoint.post("markMoved", "/api/machines/ui/threads/:threadId/moved", {
        headers: Headers,
        params: ThreadParams,
        payload: MachineMarkMovedInput,
        success: MachineThreadMove,
        error: threadError,
      }).middleware(auth),
    )
    .add(
      HttpApiEndpoint.get("moves", "/api/machines/ui/moves", {
        headers: Headers,
        success: MachineThreadMoveList,
        error,
      }).middleware(auth),
    )
    .add(
      HttpApiEndpoint.post("inventory", "/api/machines/ui/inventory", {
        headers: Headers,
        payload: MachineInventoryInput,
        success: MachineConfigInventory,
        error,
      }).middleware(auth),
    );
};
