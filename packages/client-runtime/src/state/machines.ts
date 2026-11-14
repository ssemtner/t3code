import {
  isMachineRequestRefusedError,
  type MachineCheckoutInput,
  type MachineInventoryInput,
  type MachineLocalImportInput,
  type MachineMarkMovedInput,
  type MachineReceiveInput,
  type MachineRequestRefusedError,
  type MachineSurveyInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { HttpClient, HttpMethod } from "effect/http";
import * as Result from "effect/Result";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type {
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
} from "../rpc/http.ts";
import {
  type EnvironmentHttpAuthHeaders,
  executeConnectedEnvironmentHttpRequest,
} from "./environmentHttpAuth.ts";
import { createEnvironmentCommand, createEnvironmentQueryAtomFamily } from "./runtime.ts";

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;

/**
 * The shared HTTP request layer flattens declared errors other than the common ones, so a
 * refusal rides the success channel through it and is raised again for callers.
 */
const machinesRequest = <A, E, R>(input: {
  readonly method: HttpMethod.HttpMethod;
  readonly url: (urls: ReturnType<typeof makeEnvironmentHttpApiUrlBuilder>["machines"]) => string;
  readonly timeoutMs: number;
  readonly request: (input: {
    readonly client: Effect.Success<
      ReturnType<typeof makeEnvironmentHttpApiGroupClient<"machines">>
    >;
    readonly headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E, R>;
}) =>
  executeConnectedEnvironmentHttpRequest({
    ...input,
    group: "machines",
    request: (context) =>
      input.request(context).pipe(
        Effect.map((value) => Result.succeed(value)),
        Effect.catchIf(isMachineRequestRefusedError, (refusal) =>
          Effect.succeed(Result.fail<MachineRequestRefusedError>(refusal)),
        ),
      ),
  }).pipe(Effect.flatMap((result) => Effect.fromResult(result)));

export function createMachineEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  const survey = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:machines:survey",
    staleTimeMs: 30_000,
    execute: (input: MachineSurveyInput) =>
      machinesRequest({
        method: "POST",
        url: (urls) => urls.survey(),
        timeoutMs: WRITE_TIMEOUT_MS,
        request: ({ client, headers }) => client.survey({ headers, payload: input }),
      }),
  });
  const checkout = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:machines:checkout",
    staleTimeMs: 15_000,
    execute: (input: MachineCheckoutInput) =>
      machinesRequest({
        method: "POST",
        url: (urls) => urls.checkout(),
        timeoutMs: READ_TIMEOUT_MS,
        request: ({ client, headers }) => client.checkout({ headers, payload: input }),
      }),
  });
  const inventory = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:machines:inventory",
    staleTimeMs: 30_000,
    execute: (input: MachineInventoryInput) =>
      machinesRequest({
        method: "POST",
        url: (urls) => urls.inventory(),
        timeoutMs: WRITE_TIMEOUT_MS,
        request: ({ client, headers }) => client.inventory({ headers, payload: input }),
      }),
  });
  const moves = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:machines:moves",
    staleTimeMs: 15_000,
    execute: (_input: null) =>
      machinesRequest({
        method: "GET",
        url: (urls) => urls.moves(),
        timeoutMs: READ_TIMEOUT_MS,
        request: ({ client, headers }) => client.moves({ headers }),
      }),
  });
  const moveSource = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:machines:move-source",
    staleTimeMs: 15_000,
    execute: (input: { readonly threadId: ThreadId }) =>
      machinesRequest({
        method: "GET",
        url: (urls) => urls.moveSource({ params: { threadId: input.threadId } }),
        timeoutMs: READ_TIMEOUT_MS,
        request: ({ client, headers }) =>
          client.moveSource({ headers, params: { threadId: input.threadId } }),
      }),
  });

  return {
    survey,
    checkout,
    inventory,
    moves,
    moveSource,
    receive: createEnvironmentCommand(runtime, {
      label: "environment-data:machines:receive",
      execute: (input: MachineReceiveInput) =>
        machinesRequest({
          method: "POST",
          url: (urls) => urls.receive(),
          timeoutMs: WRITE_TIMEOUT_MS,
          request: ({ client, headers }) => client.receive({ headers, payload: input }),
        }),
    }),
    importLocal: createEnvironmentCommand(runtime, {
      label: "environment-data:machines:import-local",
      execute: (input: MachineLocalImportInput) =>
        machinesRequest({
          method: "POST",
          url: (urls) => urls.importLocal(),
          timeoutMs: WRITE_TIMEOUT_MS,
          request: ({ client, headers }) => client.importLocal({ headers, payload: input }),
        }),
    }),
    transferReport: createEnvironmentCommand(runtime, {
      label: "environment-data:machines:transfer-report",
      execute: (input: { readonly transferId: string; readonly wait: boolean }) => {
        const params = { transferId: input.transferId };
        const query = input.wait ? { wait: "1" as const } : {};
        return machinesRequest({
          method: "GET",
          url: (urls) => urls.transferReport({ params, query }),
          timeoutMs: READ_TIMEOUT_MS,
          request: ({ client, headers }) => client.transferReport({ headers, params, query }),
        });
      },
    }),
    undo: createEnvironmentCommand(runtime, {
      label: "environment-data:machines:undo",
      execute: (input: { readonly transferId: string }) =>
        machinesRequest({
          method: "POST",
          url: (urls) => urls.undo({ params: { transferId: input.transferId } }),
          timeoutMs: WRITE_TIMEOUT_MS,
          request: ({ client, headers }) =>
            client.undo({ headers, params: { transferId: input.transferId } }),
        }),
    }),
    markMoved: createEnvironmentCommand(runtime, {
      label: "environment-data:machines:mark-moved",
      execute: (
        input: { readonly threadId: ThreadId } & MachineMarkMovedInput,
        registry,
        environmentId,
      ) => {
        const { threadId, ...payload } = input;
        return machinesRequest({
          method: "POST",
          url: (urls) => urls.markMoved({ params: { threadId } }),
          timeoutMs: WRITE_TIMEOUT_MS,
          request: ({ client, headers }) =>
            client.markMoved({ headers, params: { threadId }, payload }),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => registry.refresh(moves({ environmentId, input: null }))),
          ),
        );
      },
    }),
  };
}
