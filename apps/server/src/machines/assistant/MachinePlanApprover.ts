import type { MachinePlanId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

export type MachinePlanApprovalDecision = "approve" | "decline" | "cancel";

export interface MachinePlanApprovalPrompt {
  readonly planId: MachinePlanId;
  readonly stepId: string;
  /** Server-written from the stored step; never text the agent supplied. */
  readonly message: string;
}

export type MachinePlanApprovalOutcome =
  | {
      readonly _tag: "Decided";
      /** Keyed by step id; every prompted step has an entry. */
      readonly decisions: ReadonlyMap<string, MachinePlanApprovalDecision>;
    }
  | {
      /** MCP 2026-07-28: return this from the tool; the client calls again with the answers. */
      readonly _tag: "InputRequired";
      readonly inputRequired: McpSchema.InputRequired;
    };

export class MachinePlanApprovalUnavailableError extends Schema.TaggedError<MachinePlanApprovalUnavailableError>()(
  "MachinePlanApprovalUnavailableError",
  {
    reason: Schema.Literals(["no-form-elicitation", "elicitation-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "no-form-elicitation"
      ? "This MCP client cannot ask the user to approve plan steps."
      : "The approval request to the user failed.";
  }
}

export class MachinePlanApprover extends Context.Service<
  MachinePlanApprover,
  {
    /**
     * Asks the user, not the agent, to approve each step. Only an answer the
     * MCP client returns to this server counts; tool arguments never approve.
     */
    readonly decide: (
      prompts: ReadonlyArray<MachinePlanApprovalPrompt>,
    ) => Effect.Effect<
      MachinePlanApprovalOutcome,
      MachinePlanApprovalUnavailableError,
      McpSchema.McpRequestContext
    >;
  }
>()("t3/machines/assistant/MachinePlanApprover") {}

const APPROVAL_FORM = { type: "object", properties: {} } as const;

const inputKey = (nonce: string) => `machines-plan-approval-${nonce}`;

// The nonce keeps Claude's "always allow this session" grant, keyed by message, from matching another step.
const shownMessage = (prompt: MachinePlanApprovalPrompt, nonce: string) =>
  `${prompt.message} [${nonce.slice(0, 8)}]`;

const decisionOf = (response: unknown): MachinePlanApprovalDecision => {
  const action =
    typeof response === "object" && response !== null && "action" in response
      ? response.action
      : undefined;
  return action === "accept" ? "approve" : action === "decline" ? "decline" : "cancel";
};

const supportsFormElicitation = (capabilities: McpSchema.ClientCapabilities) => {
  const elicitation = capabilities.elicitation;
  if (elicitation === undefined) return false;
  // An empty object predates the form/url split and means form.
  return elicitation.form !== undefined || elicitation.url === undefined;
};

const makeElicitation = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const newNonce = random.uuidV4();
  // Outstanding questions per plan step: only an answer under the latest nonce counts.
  const pending = new Map<
    string,
    { readonly nonce: string; decision?: MachinePlanApprovalDecision }
  >();
  const pendingKey = (prompt: MachinePlanApprovalPrompt) =>
    `${prompt.planId}\u0000${prompt.stepId}`;

  const decideByReverseRequests = Effect.fn("MachinePlanApprover.decideByReverseRequests")(
    function* (
      client: McpSchema.McpServerClient["Service"],
      prompts: ReadonlyArray<MachinePlanApprovalPrompt>,
    ) {
      const decisions = new Map<string, MachinePlanApprovalDecision>();
      for (const prompt of prompts) {
        if ([...decisions.values()].includes("cancel")) {
          decisions.set(prompt.stepId, "cancel");
          continue;
        }
        const nonce = yield* newNonce;
        const result = yield* Effect.scoped(
          Effect.flatMap(client.getClient, (reverse) =>
            reverse.elicit(
              new McpSchema.ElicitRequestFormParams({
                mode: "form",
                message: shownMessage(prompt, nonce),
                requestedSchema: APPROVAL_FORM,
              }),
            ),
          ),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new MachinePlanApprovalUnavailableError({ reason: "elicitation-failed", cause }),
          ),
        );
        decisions.set(prompt.stepId, decisionOf(result));
      }
      return { _tag: "Decided", decisions } as const;
    },
  );

  const decideByInputRequests = Effect.fn("MachinePlanApprover.decideByInputRequests")(function* (
    context: McpSchema.McpRequestContext["Service"],
    prompts: ReadonlyArray<MachinePlanApprovalPrompt>,
  ) {
    const responses = context.inputResponses ?? {};
    const decisions = new Map<string, MachinePlanApprovalDecision>();
    const inputRequests: Record<string, McpSchema.McpInputRequest> = {};
    for (const prompt of prompts) {
      const entry = pending.get(pendingKey(prompt));
      if (entry?.decision !== undefined) {
        decisions.set(prompt.stepId, entry.decision);
        continue;
      }
      const response = entry === undefined ? undefined : responses[inputKey(entry.nonce)];
      if (entry !== undefined && response !== undefined) {
        entry.decision = decisionOf(response);
        decisions.set(prompt.stepId, entry.decision);
        continue;
      }
      const nonce = yield* newNonce;
      pending.set(pendingKey(prompt), { nonce });
      inputRequests[inputKey(nonce)] = {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: shownMessage(prompt, nonce),
          requestedSchema: APPROVAL_FORM,
        },
      };
    }
    if (Object.keys(inputRequests).length > 0) {
      return {
        _tag: "InputRequired",
        inputRequired: new McpSchema.InputRequired({ inputRequests }),
      } as const;
    }
    for (const prompt of prompts) pending.delete(pendingKey(prompt));
    return { _tag: "Decided", decisions } as const;
  });

  const decide: MachinePlanApprover["Service"]["decide"] = Effect.fn("MachinePlanApprover.decide")(
    function* (prompts) {
      const context = yield* McpSchema.McpRequestContext;
      if (!supportsFormElicitation(context.clientCapabilities)) {
        return yield* new MachinePlanApprovalUnavailableError({ reason: "no-form-elicitation" });
      }
      // Sessionful protocols carry reverse requests; 2026-07-28 has none and uses input requests.
      const client = yield* Effect.serviceOption(McpSchema.McpServerClient);
      return Option.isSome(client)
        ? yield* decideByReverseRequests(client.value, prompts)
        : yield* decideByInputRequests(context, prompts);
    },
  );

  return MachinePlanApprover.of({ decide });
});

export const layerElicitation = Layer.effect(MachinePlanApprover, makeElicitation);
