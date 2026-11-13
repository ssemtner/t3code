// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Digest hashes whole buffers; downloads are hashed while streaming.
import * as NodeCrypto from "node:crypto";

import {
  EnvironmentId,
  MACHINE_TRANSFER_ROUTE_PREFIX,
  MachineCheckoutIdentity,
  MachineConfigItemRead,
  MachineTransferManifest,
  type MachineTransferFile,
  MachineTransferRequest,
  PeerLinkError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as PeerLinks from "../peer/PeerLinks.ts";

const MachinePeerOperation = Schema.Literals([
  "identity",
  "prepare",
  "download",
  "release",
  "config-item",
]);
type MachinePeerOperation = typeof MachinePeerOperation.Type;

export class MachinePeerRequestError extends Schema.TaggedError<MachinePeerRequestError>()(
  "MachinePeerRequestError",
  {
    environmentId: EnvironmentId,
    operation: MachinePeerOperation,
    /** Null when the peer never answered. */
    status: Schema.NullOr(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.status === null
      ? `The source machine did not answer the ${this.operation} request.`
      : `The source machine failed the ${this.operation} request (HTTP ${this.status}).`;
  }
}

export class MachinePeerRefusedError extends Schema.TaggedError<MachinePeerRefusedError>()(
  "MachinePeerRefusedError",
  {
    environmentId: EnvironmentId,
    status: Schema.Number,
    code: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    switch (this.status) {
      case 401:
        return "The source machine no longer accepts this link. It may have been revoked there; link it again.";
      case 403:
        return "The source machine refused: Linked environments may be off there, or this link is read-only.";
      case 404:
        return "The source machine has no such project, worktree or transfer.";
      default:
        return `The source machine refused the request (HTTP ${this.status}${this.code === null ? "" : `, ${this.code}`}).`;
    }
  }
}

export class MachineTransferIntegrityError extends Schema.TaggedError<MachineTransferIntegrityError>()(
  "MachineTransferIntegrityError",
  {
    transferId: Schema.String,
    fileIndex: Schema.Number,
    expectedSize: Schema.Number,
    actualSize: Schema.Number,
  },
) {
  override get message(): string {
    return `File ${this.fileIndex} of transfer ${this.transferId} arrived damaged (${this.actualSize} of ${this.expectedSize} bytes, or the wrong content).`;
  }
}

type PeerError = PeerLinkError | MachinePeerRequestError | MachinePeerRefusedError;

export class MachinePeerClient extends Context.Service<
  MachinePeerClient,
  {
    readonly identity: (
      environmentId: EnvironmentId,
      input: { readonly projectId: string; readonly worktreePath?: string },
    ) => Effect.Effect<MachineCheckoutIdentity, PeerError>;
    /** One inventory item from the linked machine, with its content when readable. */
    readonly readConfigItem: (
      environmentId: EnvironmentId,
      itemId: string,
    ) => Effect.Effect<MachineConfigItemRead, PeerError>;
    /** Asks again while the source answers that it is still preparing. */
    readonly prepare: (
      environmentId: EnvironmentId,
      request: MachineTransferRequest,
    ) => Effect.Effect<MachineTransferManifest, PeerError>;
    /** Streams to `<destination>.part`, verifying size and SHA-256, then renames it into place. */
    readonly download: (
      environmentId: EnvironmentId,
      input: {
        readonly transferId: string;
        readonly file: MachineTransferFile;
        readonly destination: string;
      },
    ) => Effect.Effect<void, PeerError | MachineTransferIntegrityError>;
    readonly release: (
      environmentId: EnvironmentId,
      transferId: string,
    ) => Effect.Effect<void, PeerError>;
  }
>()("t3/machines/MachinePeerClient") {}

const IDENTITY_TIMEOUT = Duration.seconds(60);
// The source answers 202 after 45 s of preparing; anything slower than this is a stall.
const PREPARE_REQUEST_TIMEOUT = Duration.minutes(2);
const PREPARE_TOTAL_TIMEOUT = Duration.minutes(30);
const DOWNLOAD_HEADERS_TIMEOUT = Duration.seconds(60);
const DOWNLOAD_IDLE_TIMEOUT = Duration.seconds(60);
const MAX_ERROR_BODY = 4096;

const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(MachineTransferRequest));
const decodeIdentity = Schema.decodeUnknownEffect(MachineCheckoutIdentity);
const decodeConfigItemRead = Schema.decodeUnknownEffect(MachineConfigItemRead);
const decodeManifest = Schema.decodeUnknownEffect(MachineTransferManifest);
const ReadyBody = Schema.Struct({
  status: Schema.Literal("ready"),
  manifest: Schema.Unknown,
});
const isReadyBody = Schema.is(ReadyBody);

/** The refusal's machine-readable code, from a JSON body's `error`, `code` or `_tag`. */
const refusalCode = (text: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(text.slice(0, MAX_ERROR_BODY));
    if (typeof parsed !== "object" || parsed === null) return null;
    for (const key of ["error", "code", "_tag"] as const) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)) return value;
    }
    return null;
  } catch {
    return null;
  }
};

const makeHttp = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const fileSystem = yield* FileSystem.FileSystem;
  const baseClient = yield* HttpClient.HttpClient;
  // The token goes only to the origin PeerLinks checked; a redirect could send it anywhere.
  const httpClient = HttpClient.transform(baseClient, (response) =>
    Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
  );

  const resolve = Effect.fnUntraced(function* (environmentId: EnvironmentId) {
    if (!(yield* links.enabled)) {
      return yield* new PeerLinkError({
        reason: "disabled",
        message: PeerLinks.LINKED_ENVIRONMENTS_OFF,
      });
    }
    return yield* links.resolve(environmentId);
  });

  const send = (
    environmentId: EnvironmentId,
    operation: MachinePeerOperation,
    resolved: PeerLinks.ResolvedPeerLink,
    request: HttpClientRequest.HttpClientRequest,
    timeout: Duration.Duration,
  ) =>
    httpClient
      .execute(
        request.pipe(
          HttpClientRequest.prependUrl(resolved.url),
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${resolved.token}`,
            // Byte counts and hashes are of the file itself, never a compressed encoding.
            "accept-encoding": "identity",
          }),
        ),
      )
      .pipe(
        Effect.timeout(timeout),
        Effect.mapError(
          (cause) => new MachinePeerRequestError({ environmentId, operation, status: null, cause }),
        ),
      );

  /** Turns a non-success answer into its error. */
  const failFor = Effect.fnUntraced(function* (
    environmentId: EnvironmentId,
    operation: MachinePeerOperation,
    response: HttpClientResponse.HttpClientResponse,
  ) {
    if (response.status >= 400 && response.status < 500) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* new MachinePeerRefusedError({
        environmentId,
        status: response.status,
        code: refusalCode(text),
      });
    }
    return yield* new MachinePeerRequestError({
      environmentId,
      operation,
      status: response.status,
    });
  });

  const readJson = (
    environmentId: EnvironmentId,
    operation: MachinePeerOperation,
    response: HttpClientResponse.HttpClientResponse,
  ) =>
    response.json.pipe(
      Effect.mapError(
        (cause) =>
          new MachinePeerRequestError({
            environmentId,
            operation,
            status: response.status,
            cause,
          }),
      ),
    );

  // A refusal is still an answer: the link works, so only a failure to answer is recorded.
  const recording = <A, E extends { readonly message: string; readonly _tag: string }, R>(
    environmentId: EnvironmentId,
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.tapError((error) =>
        error._tag === "MachinePeerRequestError" || error._tag === "PeerLinkError"
          ? links.recordOutcome(environmentId, { error: error.message })
          : links.recordOutcome(environmentId, { error: null }),
      ),
      Effect.tap(() => links.recordOutcome(environmentId, { error: null })),
    );

  const identity: MachinePeerClient["Service"]["identity"] = Effect.fn(
    "MachinePeerClient.identity",
  )(function* (environmentId, input) {
    return yield* recording(
      environmentId,
      Effect.gen(function* () {
        const resolved = yield* resolve(environmentId);
        const request = HttpClientRequest.get(
          `${MACHINE_TRANSFER_ROUTE_PREFIX}/projects/${encodeURIComponent(input.projectId)}/identity`,
        ).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
          input.worktreePath === undefined
            ? (request) => request
            : HttpClientRequest.setUrlParam("worktreePath", input.worktreePath),
        );
        const response = yield* send(
          environmentId,
          "identity",
          resolved,
          request,
          IDENTITY_TIMEOUT,
        );
        if (response.status !== 200) return yield* failFor(environmentId, "identity", response);
        const body = yield* readJson(environmentId, "identity", response);
        return yield* decodeIdentity(body).pipe(
          Effect.mapError(
            (cause) =>
              new MachinePeerRequestError({
                environmentId,
                operation: "identity",
                status: 200,
                cause,
              }),
          ),
        );
      }),
    );
  });

  const readConfigItem: MachinePeerClient["Service"]["readConfigItem"] = Effect.fn(
    "MachinePeerClient.readConfigItem",
  )(function* (environmentId, itemId) {
    return yield* recording(
      environmentId,
      Effect.gen(function* () {
        const resolved = yield* resolve(environmentId);
        const request = HttpClientRequest.get(`${MACHINE_TRANSFER_ROUTE_PREFIX}/config/items`).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
          HttpClientRequest.setUrlParam("id", itemId),
        );
        const response = yield* send(
          environmentId,
          "config-item",
          resolved,
          request,
          IDENTITY_TIMEOUT,
        );
        if (response.status !== 200) return yield* failFor(environmentId, "config-item", response);
        const body = yield* readJson(environmentId, "config-item", response);
        return yield* decodeConfigItemRead(body).pipe(
          Effect.mapError(
            (cause) =>
              new MachinePeerRequestError({
                environmentId,
                operation: "config-item",
                status: 200,
                cause,
              }),
          ),
        );
      }),
    );
  });

  const prepare: MachinePeerClient["Service"]["prepare"] = Effect.fn("MachinePeerClient.prepare")(
    function* (environmentId, transferRequest) {
      return yield* recording(
        environmentId,
        Effect.gen(function* () {
          const resolved = yield* resolve(environmentId);
          const body = yield* encodeRequest(transferRequest).pipe(Effect.orDie);
          const request = HttpClientRequest.post(`${MACHINE_TRANSFER_ROUTE_PREFIX}/transfers`).pipe(
            HttpClientRequest.setHeader("accept", "application/json"),
            HttpClientRequest.setBody(HttpBody.text(body, "application/json")),
          );
          // The source keeps preparing between requests; each 202 means ask again.
          while (true) {
            const response = yield* send(
              environmentId,
              "prepare",
              resolved,
              request,
              PREPARE_REQUEST_TIMEOUT,
            );
            if (response.status === 202) continue;
            if (response.status !== 200) return yield* failFor(environmentId, "prepare", response);
            const answer = yield* readJson(environmentId, "prepare", response);
            return yield* decodeManifest(isReadyBody(answer) ? answer.manifest : answer).pipe(
              Effect.mapError(
                (cause) =>
                  new MachinePeerRequestError({
                    environmentId,
                    operation: "prepare",
                    status: 200,
                    cause,
                  }),
              ),
            );
          }
        }).pipe(
          Effect.timeoutOrElse({
            duration: PREPARE_TOTAL_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new MachinePeerRequestError({ environmentId, operation: "prepare", status: 202 }),
              ),
          }),
        ),
      );
    },
  );

  type Attempt =
    | { readonly _tag: "Done" }
    // The bytes so far are good but stopped short: worth resuming.
    | { readonly _tag: "Interrupted"; readonly written: number; readonly error: PeerError | null }
    | { readonly _tag: "Corrupt"; readonly written: number };

  // Untraced: each attempt runs inside download's span.
  const attemptDownload = Effect.fnUntraced(function* (
    environmentId: EnvironmentId,
    resolved: PeerLinks.ResolvedPeerLink,
    input: Parameters<MachinePeerClient["Service"]["download"]>[1],
    offset: number,
  ) {
    const part = `${input.destination}.part`;
    const expected = input.file.sizeBytes;
    let hash = NodeCrypto.createHash("sha256");
    let written = 0;

    const restart = Effect.gen(function* () {
      yield* fileSystem.writeFile(part, new Uint8Array());
      hash = NodeCrypto.createHash("sha256");
      written = 0;
    });
    if (offset > 0) {
      yield* fileSystem
        .stream(part, { bytesToRead: offset })
        .pipe(Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))));
      yield* fileSystem.truncate(part, offset);
      written = offset;
    } else {
      yield* restart;
    }

    const request = HttpClientRequest.get(
      `${MACHINE_TRANSFER_ROUTE_PREFIX}/transfers/${encodeURIComponent(input.transferId)}/files/${input.file.index}`,
    ).pipe(offset > 0 ? HttpClientRequest.setHeader("range", `bytes=${offset}-`) : (r) => r);
    const response = yield* send(
      environmentId,
      "download",
      resolved,
      request,
      DOWNLOAD_HEADERS_TIMEOUT,
    ).pipe(Effect.result);
    if (response._tag === "Failure") {
      return { _tag: "Interrupted", written, error: response.failure } satisfies Attempt;
    }
    const answer = response.success;
    if (answer.status === 416) {
      return { _tag: "Corrupt", written } satisfies Attempt;
    }
    if (answer.status !== 200 && answer.status !== 206) {
      const failed = yield* failFor(environmentId, "download", answer).pipe(Effect.flip);
      if (failed._tag === "MachinePeerRefusedError") return yield* failed;
      return { _tag: "Interrupted", written, error: failed } satisfies Attempt;
    }
    if (answer.status === 200 && offset > 0) {
      // The source ignored the range and is sending the whole file.
      yield* restart;
    }

    const streamed = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(part, { flag: "a" });
        yield* answer.stream.pipe(
          Stream.timeout(DOWNLOAD_IDLE_TIMEOUT),
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              if (written + chunk.length > expected) {
                return yield* new MachineTransferIntegrityError({
                  transferId: input.transferId,
                  fileIndex: input.file.index,
                  expectedSize: expected,
                  actualSize: written + chunk.length,
                });
              }
              yield* file.writeAll(chunk);
              hash.update(chunk);
              written += chunk.length;
            }),
          ),
        );
      }),
    ).pipe(Effect.result);
    if (streamed._tag === "Failure") {
      if (streamed.failure._tag === "MachineTransferIntegrityError") {
        return { _tag: "Corrupt", written: streamed.failure.actualSize } satisfies Attempt;
      }
      if (streamed.failure._tag === "PlatformError") return yield* streamed.failure;
      return {
        _tag: "Interrupted",
        written,
        error: new MachinePeerRequestError({
          environmentId,
          operation: "download",
          status: answer.status,
          cause: streamed.failure,
        }),
      } satisfies Attempt;
    }
    if (written < expected) return { _tag: "Interrupted", written, error: null } satisfies Attempt;
    if (hash.digest("hex") !== input.file.sha256.toLowerCase()) {
      return { _tag: "Corrupt", written } satisfies Attempt;
    }
    yield* fileSystem.rename(part, input.destination);
    return { _tag: "Done" } satisfies Attempt;
  });

  const download: MachinePeerClient["Service"]["download"] = Effect.fn(
    "MachinePeerClient.download",
  )(function* (environmentId, input) {
    yield* Effect.annotateCurrentSpan({
      "machines.transfer_id": input.transferId,
      "machines.file_index": input.file.index,
      "machines.file_size": input.file.sizeBytes,
    });
    const part = `${input.destination}.part`;
    const toRequestError = (cause: unknown) =>
      new MachinePeerRequestError({ environmentId, operation: "download", status: null, cause });
    return yield* recording(
      environmentId,
      Effect.gen(function* () {
        const resolved = yield* resolve(environmentId);
        const attempt = (offset: number) =>
          attemptDownload(environmentId, resolved, input, offset).pipe(
            Effect.catchTags({ PlatformError: (cause) => Effect.fail(toRequestError(cause)) }),
          );

        let outcome: Attempt = yield* attempt(0);
        if (
          outcome._tag === "Interrupted" &&
          outcome.written > 0 &&
          outcome.written < input.file.sizeBytes
        ) {
          outcome = yield* attempt(outcome.written);
        }
        if (outcome._tag !== "Done") outcome = yield* attempt(0);
        if (outcome._tag === "Done") return;
        yield* fileSystem.remove(part, { force: true }).pipe(Effect.ignore);
        if (outcome._tag === "Interrupted" && outcome.error !== null) return yield* outcome.error;
        return yield* new MachineTransferIntegrityError({
          transferId: input.transferId,
          fileIndex: input.file.index,
          expectedSize: input.file.sizeBytes,
          actualSize: outcome.written,
        });
      }),
    );
  });

  const release: MachinePeerClient["Service"]["release"] = Effect.fn("MachinePeerClient.release")(
    function* (environmentId, transferId) {
      return yield* recording(
        environmentId,
        Effect.gen(function* () {
          const resolved = yield* resolve(environmentId);
          const response = yield* send(
            environmentId,
            "release",
            resolved,
            HttpClientRequest.delete(
              `${MACHINE_TRANSFER_ROUTE_PREFIX}/transfers/${encodeURIComponent(transferId)}`,
            ),
            IDENTITY_TIMEOUT,
          );
          // Already released or swept there.
          if (response.status === 404 || (response.status >= 200 && response.status < 300)) return;
          return yield* failFor(environmentId, "release", response);
        }),
      );
    },
  );

  return MachinePeerClient.of({ identity, readConfigItem, prepare, download, release });
});

export const layerHttp = Layer.effect(MachinePeerClient, makeHttp);
