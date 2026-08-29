import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  IsoDateTime,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Cap on the prompt-bearing content of a webhook trigger (prompt + serialized
 * event). Webhook bodies are attacker-adjacent: unbounded payloads would let a
 * leaked key queue arbitrarily large provider turns.
 */
export const MAX_AUTOMATION_WEBHOOK_CONTENT_CHARS = 262_144;

/** Cap on caller-supplied idempotency keys, which flow into command ids. */
export const MAX_AUTOMATION_WEBHOOK_FIRE_KEY_CHARS = 256;

/** Arbitrary JSON object describing the triggering event; embedded into the run prompt. */
export const AutomationWebhookEvent = Schema.Record(Schema.String, Schema.Unknown);
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

/**
 * One webhook delivery the environment received, accepted or rejected.
 * Retention is bounded (oldest pruned on insert); payloads are stored as
 * received, already capped by the trigger content limit.
 */
export const AutomationEventLogEntry = Schema.Struct({
  id: TrimmedNonEmptyString.annotate({ description: "Delivery id, newest-first sortable." }),
  receivedAt: IsoDateTime,
  outcome: Schema.Literals(["accepted", "rejected"]),
  httpStatus: Schema.Int.check(Schema.isGreaterThan(0)),
  mode: Schema.NullOr(Schema.Literals(["task", "adhoc"])).annotate({
    description: "Null when the request was malformed before a mode could be resolved.",
  }),
  taskId: Schema.NullOr(ScheduledTaskId),
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId).annotate({
    description: "Thread the run dispatched to; null for rejected deliveries.",
  }),
  fireKey: Schema.NullOr(TrimmedNonEmptyString),
  /** Subject and session id of the API key that sent the delivery. */
  keySubject: TrimmedNonEmptyString,
  keySessionId: TrimmedNonEmptyString,
  errorCode: Schema.NullOr(TrimmedNonEmptyString),
  errorMessage: Schema.NullOr(Schema.String),
  eventJson: Schema.NullOr(Schema.String).annotate({
    description: "The event payload as received (JSON string); null when absent.",
  }),
});
export type AutomationEventLogEntry = typeof AutomationEventLogEntry.Type;

export const AutomationEventListInput = Schema.Struct({});
export type AutomationEventListInput = typeof AutomationEventListInput.Type;

export const AutomationEventListResult = Schema.Struct({
  events: Schema.Array(AutomationEventLogEntry).annotate({
    description: "Recent deliveries, newest first, bounded by retention.",
  }),
});
export type AutomationEventListResult = typeof AutomationEventListResult.Type;

export class AutomationEventError extends Schema.TaggedErrorClass<AutomationEventError>()(
  "AutomationEventError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
