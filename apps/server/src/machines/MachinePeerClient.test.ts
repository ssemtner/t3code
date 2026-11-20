// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test computes the expected SHA-256 the same way the client does.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, type MachineTransferFile } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as MachinePeerClient from "./MachinePeerClient.ts";

const ENVIRONMENT = EnvironmentId.make("env-source");
const TRANSFER_ID = "t-download";
const CONTENT = Uint8Array.from({ length: 50_000 }, (_, index) => (index * 31 + 7) % 251);
const CUT = 20_000;

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const FILE: MachineTransferFile = {
  index: 0,
  kind: "bundle",
  sizeBytes: CONTENT.length,
  sha256: sha256(CONTENT),
};

/** A body that sends `bytes`, then fails as a dropped connection would. */
const droppedAfter = (bytes: Uint8Array) => {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      // Erroring drops queued chunks, so the failure waits for the next read.
      if (sent) controller.error(new Error("connection reset"));
      else controller.enqueue(bytes);
      sent = true;
    },
  });
};

const corrupted = (bytes: Uint8Array) =>
  bytes.map((byte, index) => (index === 0 ? byte ^ 1 : byte));

interface Served {
  readonly range: string | undefined;
  readonly authorization: string | undefined;
  readonly encoding: string | undefined;
}

/** Answers each download request with the next response in `responses`. */
const makeLayer = (
  responses: ReadonlyArray<(request: HttpClientRequest.HttpClientRequest) => Response>,
  served: Array<Served>,
) =>
  MachinePeerClient.layerHttp.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(PeerLinks.PeerLinks)({
          enabled: Effect.succeed(true),
          resolve: (environmentId) =>
            Effect.succeed({
              link: {
                environmentId,
                label: "Source",
                urls: ["http://source.test"],
                access: "approval-required",
                linkedAt: DateTime.makeUnsafe(0),
                expiresAt: DateTime.makeUnsafe(Date.UTC(2100, 0)),
                lastReachedAt: null,
                lastError: null,
              },
              url: "http://source.test",
              token: "link-token",
            }),
          recordOutcome: () => Effect.void,
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              const respond = responses[served.length];
              served.push({
                range: request.headers["range"],
                authorization: request.headers["authorization"],
                encoding: request.headers["accept-encoding"],
              });
              return HttpClientResponse.fromWeb(
                request,
                respond === undefined ? new Response(null, { status: 500 }) : respond(request),
              );
            }),
          ),
        ),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const download = Effect.fn("test.download")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-machines-peer-" });
  const destination = path.join(directory, "0");
  const client = yield* MachinePeerClient.MachinePeerClient;
  const result = yield* client
    .download(ENVIRONMENT, { transferId: TRANSFER_ID, file: FILE, destination })
    .pipe(Effect.result);
  return {
    result,
    contents: (yield* fileSystem.exists(destination))
      ? yield* fileSystem.readFile(destination)
      : null,
    partLeft: yield* fileSystem.exists(`${destination}.part`),
  };
});

it.effect("reads a config item and maps a missing one to a refusal", () => {
  const read = {
    item: {
      id: "rule:user:style.md",
      scope: "user",
      name: "style",
      path: "/claude/rules/style.md",
      project: null,
      sizeBytes: 5,
      sha256: "abc",
      modifiedAt: null,
      category: "rule",
    },
    content: null,
  } as const;
  const served: Array<Served> = [];
  return Effect.gen(function* () {
    const client = yield* MachinePeerClient.MachinePeerClient;
    assert.deepStrictEqual(yield* client.readConfigItem(ENVIRONMENT, read.item.id), read);
    const missing = yield* client.readConfigItem(ENVIRONMENT, "nope").pipe(Effect.flip);
    assert.strictEqual(missing._tag, "MachinePeerRefusedError");
    assert.strictEqual(
      missing._tag === "MachinePeerRefusedError" ? missing.code : null,
      "config_item_not_found",
    );
    assert.match(missing.message, /no Claude config item with that id.*t3_machines_config/);
  }).pipe(
    Effect.provide(
      makeLayer(
        [
          (request) => {
            assert.strictEqual(
              request.urlParams.params.find(([key]) => key === "id")?.[1],
              read.item.id,
            );
            return Response.json(read);
          },
          () => Response.json({ error: "config_item_not_found" }, { status: 404 }),
        ],
        served,
      ),
    ),
  );
});

it.effect("resumes a dropped download from the bytes it kept", () => {
  const served: Array<Served> = [];
  return Effect.gen(function* () {
    const { result, contents, partLeft } = yield* download();
    assert.strictEqual(result._tag, "Success");
    assert.deepStrictEqual(contents, CONTENT);
    assert.isFalse(partLeft);
    assert.deepStrictEqual(served, [
      { range: undefined, authorization: "Bearer link-token", encoding: "identity" },
      { range: `bytes=${CUT}-`, authorization: "Bearer link-token", encoding: "identity" },
    ]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      makeLayer(
        [
          () => new Response(droppedAfter(CONTENT.slice(0, CUT)), { status: 200 }),
          () => new Response(CONTENT.slice(CUT), { status: 206 }),
        ],
        served,
      ),
    ),
  );
});

it.effect("retries from zero when the resumed bytes are damaged", () => {
  const served: Array<Served> = [];
  return Effect.gen(function* () {
    const { result, contents } = yield* download();
    assert.strictEqual(result._tag, "Success");
    assert.deepStrictEqual(contents, CONTENT);
    assert.deepStrictEqual(
      served.map((entry) => entry.range),
      [undefined, `bytes=${CUT}-`, undefined],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      makeLayer(
        [
          () => new Response(droppedAfter(CONTENT.slice(0, CUT)), { status: 200 }),
          () => new Response(corrupted(CONTENT.slice(CUT)), { status: 206 }),
          () => new Response(CONTENT, { status: 200 }),
        ],
        served,
      ),
    ),
  );
});

it.effect("fails with an integrity error when every copy is damaged or too long", () => {
  const served: Array<Served> = [];
  const tooLong = new Uint8Array(CONTENT.length + 1);
  tooLong.set(CONTENT);
  return Effect.gen(function* () {
    const { result, contents, partLeft } = yield* download();
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.strictEqual(result.failure._tag, "MachineTransferIntegrityError");
    }
    assert.isNull(contents);
    assert.isFalse(partLeft);
    // Damaged bytes are not worth resuming: one retry from zero, then give up.
    assert.deepStrictEqual(
      served.map((entry) => entry.range),
      [undefined, undefined],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      makeLayer(
        [
          () => new Response(corrupted(CONTENT), { status: 200 }),
          () => new Response(tooLong, { status: 200 }),
        ],
        served,
      ),
    ),
  );
});
