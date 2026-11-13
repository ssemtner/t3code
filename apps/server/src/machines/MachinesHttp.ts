import {
  MACHINE_CONFIG_READABLE_CATEGORIES,
  MACHINE_TRANSFER_ROUTE_PREFIX,
  MachineTransferRequest,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ConfigInventory from "./ConfigInventory.ts";
import * as MachineSource from "./MachineSource.ts";

const NO_STORE = { "cache-control": "no-store" };
// Receivers hash what they download, so staged bytes must reach them unencoded.
const FILE_HEADERS = {
  "cache-control": "no-store, no-transform",
  "content-type": "application/octet-stream",
  "accept-ranges": "bytes",
};
const MAX_REQUEST_BYTES = 256 * 1024;

const refuse = (status: number, error: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ error, message }, { status, headers: NO_STORE });

const decodeTransferRequest = Schema.decodeUnknownEffect(MachineTransferRequest);
const decodeProjectId = Schema.decodeUnknownOption(ProjectId);

/** The caller's session id when it is a linked environment that may act here, else the refusal. */
const authorize = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const settings = yield* ServerSettings.ServerSettingsService;
  const session = yield* auth.authenticateMcpClient(request).pipe(
    Effect.catchTags({
      ServerAuthMissingCredentialError: () => Effect.succeed(null),
      ServerAuthInvalidCredentialError: () => Effect.succeed(null),
    }),
  );
  if (session === null)
    return refuse(401, "unauthorized", "A linked environment's token is required.");
  if (!session.peerLink || session.access === "read-only") {
    return refuse(403, "forbidden", "Only a linked environment with write access can transfer.");
  }
  const linksEnabled = yield* settings.getSettings.pipe(
    Effect.map((current) => current.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );
  if (!linksEnabled) {
    return refuse(
      403,
      "linked_environments_off",
      "Linked environments is off on this machine. Turn it on in its Settings → Labs.",
    );
  }
  return session.sessionId;
});

const checkoutErrors = {
  MachineProjectNotFoundError: (error: MachineSource.MachineProjectNotFoundError) =>
    Effect.succeed(refuse(404, "project_not_found", error.message)),
  MachineWorktreeNotFoundError: (error: MachineSource.MachineWorktreeNotFoundError) =>
    Effect.succeed(refuse(404, "worktree_not_found", error.message)),
  MachineNotRepositoryError: (error: MachineSource.MachineNotRepositoryError) =>
    Effect.succeed(refuse(422, "not_repository", error.message)),
};

const transferNotFound = (error: MachineSource.MachineTransferNotFoundError) =>
  Effect.succeed(refuse(404, "transfer_not_found", error.message));

const failed = (operation: string) => (error: { readonly _tag: string }) =>
  Effect.logWarning("machines.source-request-failed", { operation, error: error._tag }).pipe(
    Effect.as(refuse(500, "internal_error", "The source machine could not complete the request.")),
  );

const identityRoute = HttpRouter.add(
  "GET",
  `${MACHINE_TRANSFER_ROUTE_PREFIX}/projects/:projectId/identity`,
  Effect.gen(function* () {
    const authorized = yield* authorize;
    if (HttpServerResponse.isHttpServerResponse(authorized)) return authorized;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const projectId = decodeProjectId((yield* HttpRouter.params).projectId);
    if (projectId._tag === "None") return refuse(400, "invalid_request", "Bad project id.");
    const worktreePath =
      new URLSearchParams(request.url.split("?", 2)[1] ?? "").get("worktreePath") || undefined;
    const source = yield* MachineSource.MachineSource;
    return yield* source
      .describeCheckout({
        projectId: projectId.value,
        ...(worktreePath === undefined ? {} : { worktreePath }),
      })
      .pipe(
        Effect.map((identity) => HttpServerResponse.jsonUnsafe(identity, { headers: NO_STORE })),
        Effect.catchTags(checkoutErrors),
        Effect.catch(failed("identity")),
      );
  }),
);

const configItemRoute = HttpRouter.add(
  "GET",
  `${MACHINE_TRANSFER_ROUTE_PREFIX}/config/items`,
  Effect.gen(function* () {
    const authorized = yield* authorize;
    if (HttpServerResponse.isHttpServerResponse(authorized)) return authorized;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const id = new URLSearchParams(request.url.split("?", 2)[1] ?? "").get("id");
    if (!id) return refuse(400, "invalid_request", "Bad config item id.");
    const inventory = yield* ConfigInventory.ConfigInventory;
    return yield* Effect.gen(function* () {
      const scanned = yield* inventory.scan({ projectRoots: [] });
      const item = scanned.items.find((candidate) => candidate.id === id);
      if (item === undefined) return yield* new ConfigInventory.ConfigItemNotFoundError({ id });
      // Only readable categories: the others can hold secrets that the metadata leaves out.
      const content = MACHINE_CONFIG_READABLE_CATEGORIES.has(item.category)
        ? yield* inventory.readItem(id)
        : null;
      return HttpServerResponse.jsonUnsafe({ item, content }, { headers: NO_STORE });
    }).pipe(
      Effect.catchTags({
        ConfigItemNotFoundError: (error) =>
          Effect.succeed(refuse(404, "config_item_not_found", error.message)),
        ConfigItemTooLargeError: (error) =>
          Effect.succeed(refuse(422, "config_item_too_large", error.message)),
      }),
      Effect.catch(failed("config-item")),
    );
  }),
);

const makePrepareRoute = (prepareWaitMs: number) =>
  HttpRouter.add(
    "POST",
    `${MACHINE_TRANSFER_ROUTE_PREFIX}/transfers`,
    Effect.gen(function* () {
      const authorized = yield* authorize;
      if (HttpServerResponse.isHttpServerResponse(authorized)) return authorized;
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (Number(request.headers["content-length"] ?? "0") > MAX_REQUEST_BYTES) {
        return refuse(413, "invalid_request", "The transfer request is too large.");
      }
      const body = yield* request.json.pipe(Effect.flatMap(decodeTransferRequest), Effect.option);
      if (body._tag === "None") return refuse(400, "invalid_request", "Bad transfer request.");
      const source = yield* MachineSource.MachineSource;
      return yield* source
        .prepareTransfer({ ...body.value, requesterSessionId: authorized, waitMs: prepareWaitMs })
        .pipe(
          Effect.map((result) =>
            result.status === "ready"
              ? HttpServerResponse.jsonUnsafe(result.manifest, { headers: NO_STORE })
              : HttpServerResponse.jsonUnsafe(result, { status: 202, headers: NO_STORE }),
          ),
          Effect.catchTags({
            ...checkoutErrors,
            WorkingTreeHeadMissingError: () =>
              Effect.succeed(refuse(422, "no_commits", "The checkout has no commit yet.")),
            MachineRefNameInvalidError: () =>
              Effect.succeed(refuse(400, "invalid_request", "The transfer id is not valid.")),
            MachineTransferConflictError: (error) =>
              Effect.succeed(refuse(409, "transfer_conflict", error.message)),
          }),
          Effect.catch(failed("prepare")),
        );
    }),
  );

const fileRoute = HttpRouter.add(
  "GET",
  `${MACHINE_TRANSFER_ROUTE_PREFIX}/transfers/:transferId/files/:fileIndex`,
  Effect.gen(function* () {
    const authorized = yield* authorize;
    if (HttpServerResponse.isHttpServerResponse(authorized)) return authorized;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    const fileIndex = Number(params.fileIndex);
    if (!params.transferId || !Number.isSafeInteger(fileIndex) || fileIndex < 0) {
      return refuse(400, "invalid_request", "Bad file reference.");
    }
    const source = yield* MachineSource.MachineSource;
    return yield* source
      .openStagedFile({ transferId: params.transferId, fileIndex, requesterSessionId: authorized })
      .pipe(
        Effect.flatMap((file) => {
          // Only the resume form a receiver sends; anything else gets the whole file.
          const range = /^bytes=(\d+)-$/.exec(request.headers.range?.trim() ?? "");
          const offset = range === null ? 0 : Number(range[1]);
          if (offset > 0 && offset >= file.sizeBytes) {
            return Effect.succeed(
              HttpServerResponse.empty({
                status: 416,
                headers: { ...FILE_HEADERS, "content-range": `bytes */${file.sizeBytes}` },
              }),
            );
          }
          return HttpServerResponse.file(file.path, {
            status: offset > 0 ? 206 : 200,
            offset,
            bytesToRead: file.sizeBytes - offset,
            headers: {
              ...FILE_HEADERS,
              "x-content-sha256": file.sha256,
              ...(offset > 0
                ? { "content-range": `bytes ${offset}-${file.sizeBytes - 1}/${file.sizeBytes}` }
                : {}),
            },
          });
        }),
        Effect.catchTags({ MachineTransferNotFoundError: transferNotFound }),
        Effect.catch(failed("file")),
      );
  }),
);

const releaseRoute = HttpRouter.add(
  "DELETE",
  `${MACHINE_TRANSFER_ROUTE_PREFIX}/transfers/:transferId`,
  Effect.gen(function* () {
    const authorized = yield* authorize;
    if (HttpServerResponse.isHttpServerResponse(authorized)) return authorized;
    const transferId = (yield* HttpRouter.params).transferId ?? "";
    const source = yield* MachineSource.MachineSource;
    return yield* source
      .releaseTransfer({ transferId, requesterSessionId: authorized })
      .pipe(
        Effect.as(HttpServerResponse.empty({ status: 204, headers: NO_STORE })),
        Effect.catchTags({ MachineTransferNotFoundError: transferNotFound }),
        Effect.catch(failed("release")),
      );
  }),
);

/** The source side of machine transfers; `prepareWaitMs` bounds how long a POST holds. */
export const makeRoutes = (options: { readonly prepareWaitMs: number }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      // Handlers' services come from the request context; hand them the one shared instance.
      const source = yield* MachineSource.MachineSource;
      const inventory = yield* ConfigInventory.ConfigInventory;
      return Layer.mergeAll(
        identityRoute,
        configItemRoute,
        makePrepareRoute(options.prepareWaitMs),
        fileRoute,
        releaseRoute,
      ).pipe(
        HttpRouter.provideRequest(
          Layer.mergeAll(
            Layer.succeed(MachineSource.MachineSource, source),
            Layer.succeed(ConfigInventory.ConfigInventory, inventory),
          ),
        ),
      );
    }),
  );

export const layer = makeRoutes({ prepareWaitMs: 45_000 });
