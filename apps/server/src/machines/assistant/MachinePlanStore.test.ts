import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as MachinePlanStore from "./MachinePlanStore.ts";

const layer = MachinePlanStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-machine-plans-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const input = {
  threadId: null,
  title: "Move setup",
  notes: [] as ReadonlyArray<string>,
  steps: [],
};

it.layer(layer)("MachinePlanStore", (it) => {
  it.effect("round-trips a plan", () =>
    Effect.gen(function* () {
      const store = yield* MachinePlanStore.MachinePlanStore;
      const created = yield* store.create({ ...input, notes: ["a"] });
      assert.match(created.id, /^mp-/);
      assert.deepStrictEqual(yield* store.get(created.id), created);
    }),
  );

  it.effect("serializes concurrent updates", () =>
    Effect.gen(function* () {
      const store = yield* MachinePlanStore.MachinePlanStore;
      const { id } = yield* store.create(input);
      yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => `n${index}`),
        (note) => store.update(id, (plan) => ({ ...plan, notes: [...plan.notes, note] })),
        { concurrency: "unbounded" },
      );
      assert.strictEqual((yield* store.get(id)).notes.length, 20);
    }),
  );

  it.effect("fails with tagged errors for unknown and malformed ids", () =>
    Effect.gen(function* () {
      const store = yield* MachinePlanStore.MachinePlanStore;
      for (const planId of ["mp-00000000-0000-4000-8000-000000000000", "../../etc/passwd"]) {
        const error = yield* Effect.flip(store.get(planId));
        assert.strictEqual(error._tag, "MachinePlanNotFoundError");
      }
    }),
  );

  it.effect("sweeps plans untouched for 30 days", () =>
    Effect.gen(function* () {
      const store = yield* MachinePlanStore.MachinePlanStore;
      const old = yield* store.create(input);
      yield* TestClock.adjust(Duration.days(31));
      const fresh = yield* store.create(input);
      yield* store.sweep;
      assert.strictEqual((yield* Effect.flip(store.get(old.id)))._tag, "MachinePlanNotFoundError");
      assert.strictEqual((yield* store.get(fresh.id)).id, fresh.id);
    }),
  );
});
