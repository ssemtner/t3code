import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type MachineConfigItem,
  type MachinePlanStepDraft,
  type MachineTransferReport,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { McpSchema } from "effect/ai";

import * as ServerConfig from "../../config.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as PeerMcpClient from "../../peer/PeerMcpClient.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as SourceControlRepositoryService from "../../sourceControl/SourceControlRepositoryService.ts";
import * as MachinePeerClient from "../MachinePeerClient.ts";
import * as MachineReceiver from "../MachineReceiver.ts";
import * as MachineConfigApply from "./MachineConfigApply.ts";
import * as MachinePlanApprover from "./MachinePlanApprover.ts";
import * as MachinePlanRunner from "./MachinePlanRunner.ts";
import * as MachinePlanStore from "./MachinePlanStore.ts";

const here = EnvironmentId.make("environment:here");
const source = EnvironmentId.make("environment:source");
const remoteDestination = EnvironmentId.make("environment:dest");

const SECRET = "sekret-token-value";

const item = (id: string, overrides: Partial<MachineConfigItem> = {}) =>
  ({
    id,
    category: "agent",
    scope: "user",
    name: id,
    path: `/source/.claude/agents/${id}.md`,
    project: null,
    sizeBytes: 1,
    sha256: "item",
    modifiedAt: null,
    description: null,
    ...overrides,
  }) as MachineConfigItem;

const report = (transferId: string, status: MachineTransferReport["status"]) =>
  ({
    transferId,
    status,
    phase: status,
    sourceEnvironmentId: source,
    destination: { projectId: ProjectId.make("project:dest"), root: "/dest" },
    workingTree: null,
    sessions: [],
    undo: { available: true, undoneAt: null },
    error: status === "failed" ? "source went away" : null,
  }) satisfies MachineTransferReport;

const copy = (id: string, dependsOn: ReadonlyArray<string> = []): MachinePlanStepDraft => ({
  id,
  dependsOn: [...dependsOn],
  type: "copy-config",
  input: { sourceEnvironmentId: source, itemId: id },
});

const receive = (
  id: string,
  destinationEnvironmentId: EnvironmentId | null = null,
): MachinePlanStepDraft => ({
  id,
  dependsOn: [],
  type: "receive",
  input: {
    destinationEnvironmentId,
    receive: {
      sourceEnvironmentId: source,
      sourceProjectId: ProjectId.make("project:source"),
      sessionIds: ["session-1"],
    },
  },
});

interface World {
  /** Source items by id; content is the item id unless overridden. */
  readonly sourceFiles: Ref.Ref<ReadonlyMap<string, string>>;
  /** Destination files by path. */
  readonly files: Ref.Ref<ReadonlyMap<string, string>>;
  readonly calls: Ref.Ref<ReadonlyArray<string>>;
  readonly answers: Ref.Ref<
    ReadonlyArray<
      "input-required" | Record<string, MachinePlanApprover.MachinePlanApprovalDecision>
    >
  >;
  readonly receiveStatus: Ref.Ref<MachineTransferReport["status"]>;
}

const sha = (content: string) => `sha:${content}`;

const makeLayer = (world: World) => {
  const log = (entry: string) => Ref.update(world.calls, (all) => [...all, entry]);
  const mcpItems: Record<string, MachineConfigItem> = {
    "mcp-server:user:github": {
      ...item("mcp-server:user:github"),
      category: "mcp-server",
      name: "github",
      mcpScope: "user",
      transport: "stdio",
      command: "npx",
      // A source that leaked more than the inventory carries must still not reach the plan.
      ...({
        env: { TOKEN: SECRET },
        args: [`--api-key=${SECRET}`],
        headers: { auth: SECRET },
      } as object),
    } as MachineConfigItem,
  };
  return MachinePlanRunner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(here) }),
        Layer.mock(PeerLinks.PeerLinks)({ get: () => Effect.succeedNone }),
        Layer.mock(MachinePeerClient.MachinePeerClient)({
          identity: (_environmentId, input) =>
            Effect.succeed({
              projectId: ProjectId.make(input.projectId),
              projectRoot: "/source/repo",
              checkoutRoot: "/source/repo",
              head: null,
              branch: null,
              remotes: [],
              rootCommits: [],
            }),
          readConfigItem: (_environmentId, itemId) =>
            Effect.gen(function* () {
              const mcp = mcpItems[itemId];
              if (mcp !== undefined) return { item: mcp, content: null };
              const content = (yield* Ref.get(world.sourceFiles)).get(itemId) ?? itemId;
              return {
                item: item(itemId),
                content: {
                  id: itemId,
                  path: `/source/${itemId}`,
                  content,
                  sizeBytes: content.length,
                  sha256: sha(content),
                },
              };
            }),
        }),
        Layer.mock(MachineConfigApply.MachineConfigApply)({
          destinationOf: (configItem) => Effect.succeed(`/dest/${configItem.id}`),
          sha256Of: (path) =>
            Ref.get(world.files).pipe(
              Effect.map((files) => {
                const content = files.get(path);
                return content === undefined ? null : sha(content);
              }),
            ),
          write: (input) =>
            Effect.gen(function* () {
              const current = (yield* Ref.get(world.files)).get(input.path);
              if ((current === undefined ? null : sha(current)) !== input.expectedSha256) {
                return yield* new MachineConfigApply.MachineConfigStaleError({ path: input.path });
              }
              yield* log(`write:${input.path}`);
              yield* Ref.update(world.files, (files) =>
                new Map(files).set(input.path, input.content),
              );
              return { replacedExisting: current !== undefined };
            }),
          restore: (input) =>
            Effect.gen(function* () {
              yield* log(`restore:${input.path}`);
              yield* Ref.update(world.files, (files) => {
                const next = new Map(files);
                next.delete(input.path);
                return next;
              });
            }),
        }),
        Layer.mock(MachineReceiver.MachineReceiver)({
          receive: (input) =>
            Effect.gen(function* () {
              yield* log(`receive:${input.sourceProjectId}`);
              return report(input.transferId!, yield* Ref.get(world.receiveStatus));
            }),
          undo: (input) =>
            log(`undo:${input.transferId}`).pipe(Effect.as(report(input.transferId, "completed"))),
        }),
        Layer.mock(PeerMcpClient.PeerMcpClient)({
          call: (input) =>
            Effect.gen(function* () {
              const keys = Object.keys(input.arguments).toSorted().join(",");
              yield* log(`peer:${input.environmentId}:${input.tool}:${keys}`);
              const transferId = String(input.arguments.transferId);
              // The first receive is still running; asking again by transfer id finishes it.
              return report(
                transferId,
                keys === "transferId" || input.tool === "t3_machines_undo"
                  ? "completed"
                  : "running",
              );
            }) as never,
        }),
        Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.succeed(
          MachinePlanApprover.MachinePlanApprover,
          MachinePlanApprover.MachinePlanApprover.of({
            decide: (prompts) =>
              Effect.gen(function* () {
                const [next, ...rest] = yield* Ref.get(world.answers);
                yield* Ref.set(world.answers, rest);
                yield* log(`ask:${prompts.map((prompt) => prompt.stepId).join(",")}`);
                if (next === "input-required") {
                  return {
                    _tag: "InputRequired" as const,
                    inputRequired: new McpSchema.InputRequired({
                      inputRequests: {
                        k: {
                          method: "elicitation/create",
                          params: {
                            mode: "form",
                            message: "m",
                            requestedSchema: { type: "object", properties: {} },
                          },
                        },
                      },
                    }),
                  };
                }
                return {
                  _tag: "Decided" as const,
                  decisions: new Map(
                    prompts.map((prompt) => [prompt.stepId, next?.[prompt.stepId] ?? "approve"]),
                  ),
                };
              }),
          }),
        ),
        MachinePlanStore.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-machine-runner-" })),
        ),
      ),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
};

const requestContext = McpSchema.McpRequestContext.of({
  clientId: 1,
  protocolVersion: "2026-07-28",
  clientCapabilities: { elicitation: {} },
});

const withWorld = <A, E>(
  body: (world: World) => Effect.Effect<A, E, MachinePlanRunner.MachinePlanRunner>,
) =>
  Effect.gen(function* () {
    const world: World = {
      sourceFiles: yield* Ref.make<ReadonlyMap<string, string>>(new Map()),
      files: yield* Ref.make<ReadonlyMap<string, string>>(new Map()),
      calls: yield* Ref.make<ReadonlyArray<string>>([]),
      answers: yield* Ref.make<World["answers"] extends Ref.Ref<infer A> ? A : never>([]),
      receiveStatus: yield* Ref.make<MachineTransferReport["status"]>("completed"),
    };
    return yield* body(world).pipe(
      Effect.provide(makeLayer(world)),
      Effect.provideService(McpSchema.McpRequestContext, requestContext),
    );
  });

const execute = (planId: string, stepIds?: ReadonlyArray<string>) =>
  Effect.flatMap(MachinePlanRunner.MachinePlanRunner, (runner) =>
    runner.execute({ planId, stepIds }),
  ).pipe(Effect.provideService(McpSchema.McpRequestContext, requestContext));

const statuses = (outcome: MachinePlanRunner.MachinePlanRunOutcome) =>
  outcome._tag === "Finished"
    ? Object.fromEntries(outcome.plan.steps.map((step) => [step.id, step.status]))
    : outcome._tag;

const propose = (steps: ReadonlyArray<MachinePlanStepDraft>) =>
  Effect.flatMap(MachinePlanRunner.MachinePlanRunner, (runner) =>
    runner.propose({ threadId: null, title: "Move", notes: [], steps }),
  );

it.effect("stops at the first failure and leaves the rest not run", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      const plan = yield* propose([copy("a"), receive("r"), copy("c")]);
      yield* Ref.set(world.receiveStatus, "failed");
      const outcome = yield* execute(plan.id);
      expect(statuses(outcome)).toEqual({ a: "done", r: "failed", c: "not-run" });
      expect(yield* Ref.get(world.calls)).toEqual([
        "ask:a,r,c",
        "write:/dest/a",
        "receive:project:source",
      ]);
    }),
  ),
);

it.effect("a declined step skips the steps that depend on it", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      const plan = yield* propose([copy("a"), copy("b", ["a"]), copy("c")]);
      yield* Ref.set(world.answers, [{ a: "decline" }]);
      expect(statuses(yield* execute(plan.id))).toEqual({ a: "declined", b: "skipped", c: "done" });
    }),
  ),
);

it.effect("a destination changed since the proposal fails the step", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      const plan = yield* propose([copy("a"), copy("b")]);
      yield* Ref.update(world.files, (files) => new Map(files).set("/dest/a", "edited meanwhile"));
      const outcome = yield* execute(plan.id);
      expect(statuses(outcome)).toEqual({ a: "failed", b: "not-run" });
      expect(outcome._tag === "Finished" && outcome.plan.steps[0]?.result?.message).toMatch(
        /changed since the plan was proposed/,
      );
    }),
  ),
);

it.effect("a source changed since the proposal fails the step", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      const plan = yield* propose([copy("a")]);
      yield* Ref.update(world.sourceFiles, (files) => new Map(files).set("a", "new content"));
      expect(statuses(yield* execute(plan.id))).toEqual({ a: "failed" });
      expect((yield* Ref.get(world.calls)).filter((call) => call.startsWith("write"))).toEqual([]);
    }),
  ),
);

it.effect("undo runs completed steps in reverse", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      const runner = yield* MachinePlanRunner.MachinePlanRunner;
      const plan = yield* propose([copy("a"), copy("b"), receive("r")]);
      yield* execute(plan.id);
      yield* Ref.set(world.calls, []);
      const outcome = yield* runner
        .undo({ planId: plan.id })
        .pipe(Effect.provideService(McpSchema.McpRequestContext, requestContext));
      expect(statuses(outcome)).toEqual({ a: "undone", b: "undone", r: "undone" });
      const calls = yield* Ref.get(world.calls);
      expect(calls[0]).toBe("ask:undo:r,undo:b,undo:a");
      expect(calls.slice(1).map((call) => call.split(":")[0])).toEqual([
        "undo",
        "restore",
        "restore",
      ]);
      expect(calls.slice(2)).toEqual(["restore:/dest/b", "restore:/dest/a"]);
    }),
  ),
);

it.effect("an MCP server becomes a note without its env, args or headers", () =>
  withWorld(() =>
    Effect.gen(function* () {
      const plan = yield* propose([
        copy("mcp-server:user:github"),
        copy("a", ["mcp-server:user:github"]),
      ]);
      expect(plan.steps.map((step) => [step.id, step.dependsOn])).toEqual([["a", []]]);
      expect(plan.notes).toEqual([
        'MCP server "github" (stdio, `npx`) on machine environment:source: add it here yourself and fill in its env, args and headers.',
      ]);
      expect(JSON.stringify(plan)).not.toContain(SECRET);
    }),
  ),
);

it.effect("a receive on another machine goes through its t3_machines_receive and undo", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      const runner = yield* MachinePlanRunner.MachinePlanRunner;
      const plan = yield* propose([receive("r", remoteDestination)]);
      expect(plan.steps[0]?.summary).toBe(
        "Receive 1 Claude session and uncommitted work (applied only if the checkout matches) from project project:source on machine environment:source into the matching project on machine environment:dest.",
      );
      const outcome = yield* execute(plan.id);
      expect(statuses(outcome)).toEqual({ r: "done" });
      yield* runner
        .undo({ planId: plan.id })
        .pipe(Effect.provideService(McpSchema.McpRequestContext, requestContext));
      expect((yield* Ref.get(world.calls)).filter((call) => call.startsWith("peer"))).toEqual([
        "peer:environment:dest:t3_machines_receive:sessionIds,sourceEnvironmentId,sourceProjectId,transferId",
        "peer:environment:dest:t3_machines_receive:transferId",
        "peer:environment:dest:t3_machines_undo:transferId",
      ]);
    }),
  ),
);

it.effect("input required runs nothing; the follow-up call runs only approved steps", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      const plan = yield* propose([copy("a"), copy("b")]);
      yield* Ref.set(world.answers, ["input-required", { b: "decline" }]);
      const first = yield* execute(plan.id);
      expect(first._tag).toBe("InputRequired");
      const runner = yield* MachinePlanRunner.MachinePlanRunner;
      expect((yield* runner.status(plan.id)).steps.map((step) => step.status)).toEqual([
        "proposed",
        "proposed",
      ]);
      expect(statuses(yield* execute(plan.id))).toEqual({ a: "done", b: "declined" });
      expect(yield* Ref.get(world.calls)).toEqual(["ask:a,b", "ask:a,b", "write:/dest/a"]);
    }),
  ),
);

it.effect("refuses a dependency on a later or unknown step", () =>
  withWorld(() =>
    Effect.gen(function* () {
      const error = yield* propose([copy("a", ["b"]), copy("b")]).pipe(Effect.flip);
      expect(error.message).toBe("Step a depends on b, which is not an earlier step.");
    }),
  ),
);
