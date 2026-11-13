import {
  MachinePlan,
  MachinePlanId,
  type MachinePlanStep,
  type MachinePlanStepId,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ServerConfig from "../../config.ts";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class MachinePlanNotFoundError extends Schema.TaggedError<MachinePlanNotFoundError>()(
  "MachinePlanNotFoundError",
  { planId: Schema.String },
) {
  override get message(): string {
    return `No machine plan ${this.planId.slice(0, 128)} exists.`;
  }
}

export class MachinePlanReadError extends Schema.TaggedError<MachinePlanReadError>()(
  "MachinePlanReadError",
  { planId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Machine plan ${this.planId.slice(0, 128)} could not be read.`;
  }
}

export class MachinePlanWriteError extends Schema.TaggedError<MachinePlanWriteError>()(
  "MachinePlanWriteError",
  { planId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Machine plan ${this.planId.slice(0, 128)} could not be saved.`;
  }
}

export interface MachinePlanCreateInput {
  readonly threadId: ThreadId | null;
  readonly title: string;
  readonly notes: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<MachinePlanStep>;
}

export class MachinePlanStore extends Context.Service<
  MachinePlanStore,
  {
    readonly create: (
      input: MachinePlanCreateInput,
    ) => Effect.Effect<MachinePlan, MachinePlanWriteError>;
    readonly get: (
      planId: string,
    ) => Effect.Effect<MachinePlan, MachinePlanNotFoundError | MachinePlanReadError>;
    /** Serialized per plan; bumps `updatedAt`. */
    readonly update: (
      planId: string,
      f: (plan: MachinePlan) => MachinePlan,
    ) => Effect.Effect<
      MachinePlan,
      MachinePlanNotFoundError | MachinePlanReadError | MachinePlanWriteError
    >;
    /** Where a config step keeps what it overwrote; the store never writes there itself. */
    readonly backupPath: (planId: string, stepId: MachinePlanStepId) => string;
    /** Deletes plans untouched for 30 days. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/machines/assistant/MachinePlanStore") {}

const decodePlanId = Schema.decodeUnknownEffect(MachinePlanId);
const decodePlan = Schema.decodeUnknownEffect(Schema.fromJsonString(MachinePlan));
const encodePlan = Schema.encodeEffect(Schema.fromJsonString(MachinePlan));

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const locks = yield* KeyedLock.make<string>();
  const plansDir = path.join(stateDir, "machines", "plans");
  const planFile = (planId: string) => path.join(plansDir, `${planId}.json`);
  const backupPath = (planId: string, stepId: string) =>
    path.join(plansDir, planId, "backup", stepId);

  const validId = (planId: string) =>
    decodePlanId(planId).pipe(Effect.mapError(() => new MachinePlanNotFoundError({ planId })));

  const readFile = Effect.fn("MachinePlanStore.readFile")(function* (planId: string) {
    const file = planFile(planId);
    if (!(yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new MachinePlanNotFoundError({ planId });
    }
    return yield* fileSystem.readFileString(file).pipe(
      Effect.flatMap(decodePlan),
      Effect.mapError((cause) => new MachinePlanReadError({ planId, cause })),
    );
  });

  const writeFile = Effect.fn("MachinePlanStore.writeFile")(function* (plan: MachinePlan) {
    const file = planFile(plan.id);
    const temporary = `${file}.tmp-${yield* random.uuidV4()}`;
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(plansDir, { recursive: true });
      yield* fileSystem.writeFileString(temporary, yield* encodePlan(plan));
      yield* fileSystem.rename(temporary, file);
    }).pipe(
      Effect.tapError(() => fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
      Effect.mapError((cause) => new MachinePlanWriteError({ planId: plan.id, cause })),
    );
  });

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const create = Effect.fn("MachinePlanStore.create")(function* (input: MachinePlanCreateInput) {
    const id = MachinePlanId.make(`mp-${yield* random.uuidV4()}`);
    const now = yield* nowIso;
    const plan: MachinePlan = {
      id,
      threadId: input.threadId,
      createdAt: now,
      updatedAt: now,
      title: input.title,
      notes: input.notes,
      steps: input.steps,
    };
    yield* locks.withLock(id, writeFile(plan));
    return plan;
  });

  const get = Effect.fn("MachinePlanStore.get")(function* (planId: string) {
    return yield* readFile(yield* validId(planId));
  });

  const update = Effect.fn("MachinePlanStore.update")(function* (
    planId: string,
    f: (plan: MachinePlan) => MachinePlan,
  ) {
    const id = yield* validId(planId);
    return yield* locks.withLock(
      id,
      Effect.gen(function* () {
        const next: MachinePlan = { ...f(yield* readFile(id)), id, updatedAt: yield* nowIso };
        yield* writeFile(next);
        return next;
      }),
    );
  });

  const sweepOne = Effect.fn("MachinePlanStore.sweepOne")(function* (file: string) {
    const planId = path.basename(file, ".json");
    const plan = yield* readFile(planId);
    const cutoff = (yield* Clock.currentTimeMillis) - RETENTION_MS;
    if (Date.parse(plan.updatedAt) >= cutoff) return;
    yield* fileSystem.remove(file, { force: true });
    yield* fileSystem.remove(path.join(plansDir, planId), { recursive: true, force: true });
  });

  const sweep = Effect.gen(function* () {
    const names = yield* fileSystem.readDirectory(plansDir);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      yield* locks
        .withLock(name.slice(0, -".json".length), sweepOne(path.join(plansDir, name)))
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("machine plan sweep skipped a plan", { name, cause }),
          ),
        );
    }
  }).pipe(
    Effect.catch((cause) =>
      cause._tag === "PlatformError" && cause.reason._tag === "NotFound"
        ? Effect.void
        : Effect.logWarning("machine plan sweep failed", { cause }),
    ),
  );

  yield* sweep;

  return MachinePlanStore.of({ create, get, update, backupPath, sweep });
});

export const layer = Layer.effect(MachinePlanStore, make);
