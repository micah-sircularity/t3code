import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { ProjectId, ScheduledTaskId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Cap on the prompt-bearing content of a webhook trigger (prompt + serialized
 * event). Webhook bodies are attacker-adjacent: unbounded payloads would let a
 * leaked key queue arbitrarily large provider turns.
 */
export const MAX_AUTOMATION_WEBHOOK_CONTENT_CHARS = 262_144;

/** Cap on caller-supplied idempotency keys, which flow into command ids. */
export const MAX_AUTOMATION_WEBHOOK_FIRE_KEY_CHARS = 256;

/** Arbitrary JSON object describing the triggering event; embedded into the run prompt. */
const AutomationWebhookEvent = Schema.Record(Schema.String, Schema.Unknown);
export type AutomationWebhookEvent = typeof AutomationWebhookEvent.Type;

/**
 * Webhook automation trigger. Exactly one of `taskId` (fire a saved task with
 * a `{ type: "webhook" }` schedule) or `prompt` (launch a fresh thread in
 * `projectId`, inheriting that project's model/runtime settings) must be set.
 */
export const AutomationWebhookTriggerRequest = Schema.Struct({
  taskId: Schema.optional(ScheduledTaskId).annotate({
    description: "Fire this saved scheduled task. Mutually exclusive with prompt.",
  }),
  prompt: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "Launch a fresh thread with this prompt. Mutually exclusive with taskId; requires projectId.",
  }),
  projectId: Schema.optional(ProjectId).annotate({
    description: "Project to run an ad-hoc prompt in; required when prompt is set.",
  }),
  title: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Optional thread title for an ad-hoc prompt run.",
  }),
  event: Schema.optional(AutomationWebhookEvent).annotate({
    description: "Arbitrary JSON event payload embedded into the run prompt for the agent to read.",
  }),
  fireKey: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "Optional idempotency key scoped to the task (for example the GitHub delivery GUID); " +
      "redeliveries with the same key do not run twice.",
  }),
}).annotate({
  description: "Trigger an automation via webhook: fire a saved task or run an ad-hoc prompt.",
});
export type AutomationWebhookTriggerRequest = typeof AutomationWebhookTriggerRequest.Type;

export const AutomationWebhookTriggerResult = Schema.Struct({
  taskId: Schema.optional(ScheduledTaskId).annotate({
    description: "Present when a saved task was fired.",
  }),
  threadId: ThreadId.annotate({
    description: "Thread the run dispatched to (new for ad-hoc prompts and unbound tasks).",
  }),
}).annotate({ description: "Accepted webhook trigger." });
export type AutomationWebhookTriggerResult = typeof AutomationWebhookTriggerResult.Type;

export class AutomationWebhookInvalidRequestError extends Schema.TaggedErrorClass<AutomationWebhookInvalidRequestError>()(
  "AutomationWebhookInvalidRequestError",
  {
    code: Schema.Literal("invalid_request"),
    message: Schema.String,
  },
  { httpApiStatus: 422 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(AutomationWebhookInvalidRequestError)(this, {
      status: 422,
    });
  }
}

export class AutomationWebhookNotFoundError extends Schema.TaggedErrorClass<AutomationWebhookNotFoundError>()(
  "AutomationWebhookNotFoundError",
  {
    code: Schema.Literal("not_found"),
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(AutomationWebhookNotFoundError)(this, { status: 404 });
  }
}

export class AutomationWebhookConflictError extends Schema.TaggedErrorClass<AutomationWebhookConflictError>()(
  "AutomationWebhookConflictError",
  {
    code: Schema.Literal("conflict"),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(AutomationWebhookConflictError)(this, { status: 409 });
  }
}

export class AutomationWebhookPayloadTooLargeError extends Schema.TaggedErrorClass<AutomationWebhookPayloadTooLargeError>()(
  "AutomationWebhookPayloadTooLargeError",
  {
    code: Schema.Literal("payload_too_large"),
    message: Schema.String,
  },
  { httpApiStatus: 413 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(AutomationWebhookPayloadTooLargeError)(this, {
      status: 413,
    });
  }
}
