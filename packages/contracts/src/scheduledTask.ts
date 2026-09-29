import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/** 24-hour "HH:MM" wall-clock time. Mirrors `parseTimeOfDay` on the server. */
const TimeOfDay = TrimmedNonEmptyString.check(
  Schema.isPattern(/^([01]?\d|2[0-3]):([0-5]\d)$/),
).annotate({ description: "Local wall-clock time in 24-hour HH:MM form, such as 09:30." });

export const MIN_SCHEDULED_TASK_INTERVAL_MS = 60_000;

const ScheduledTaskIntervalMs = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  description: "Positive interval in milliseconds.",
});

const ScheduledTaskIntervalSchedule = Schema.Struct({
  type: Schema.Literal("interval").annotate({
    description: "Select interval scheduling.",
  }),
  everyMs: ScheduledTaskIntervalMs,
}).annotate({
  description: "Run repeatedly after a fixed number of milliseconds.",
});

const ScheduledTaskFixedTimeSchedule = Schema.Struct({
  type: Schema.Literal("fixed_time").annotate({
    description: "Select a fixed local wall-clock time.",
  }),
  timeOfDay: TimeOfDay,
  weekdays: Schema.optional(
    Schema.Array(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })).annotate({
        description: "Weekday number where 0 is Sunday and 6 is Saturday.",
      }),
    ).annotate({
      description: "Optional weekdays; omit to run every day.",
    }),
  ),
}).annotate({
  description: "Run at a fixed local wall-clock time on selected weekdays.",
});

export const ScheduledTaskWebhookSource = Schema.Literals(["any", "github", "basecamp"]);
export type ScheduledTaskWebhookSource = typeof ScheduledTaskWebhookSource.Type;

export const ScheduledTaskWebhookSample = Schema.Struct({
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: 'Delivery headers, such as {"x-github-event": "pull_request"}.',
  }),
  body: Schema.String.annotate({ description: "Raw request body, usually JSON." }),
});
export type ScheduledTaskWebhookSample = typeof ScheduledTaskWebhookSample.Type;

export const WorkflowAgentRoute = Schema.Union([
  Schema.Struct({ type: Schema.Literal("auto") }),
  Schema.Struct({
    type: Schema.Literal("environment"),
    environmentId: TrimmedNonEmptyString,
    label: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type WorkflowAgentRoute = typeof WorkflowAgentRoute.Type;

export const WorkflowAgent = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  prompt: Schema.String,
  /** Provider and model for this step. Omit to use the task model. */
  modelSelection: Schema.optional(ModelSelection),
  route: Schema.optional(WorkflowAgentRoute),
  /** "wait" parks until a later event for the same work. "continue" starts the next agent when this one finishes verified. */
  advance: Schema.optional(Schema.Literals(["continue", "wait"])),
});
export type WorkflowAgent = typeof WorkflowAgent.Type;

export const WorkflowDelivery = Schema.Struct({
  summary: Schema.optional(Schema.String),
});
export type WorkflowDelivery = typeof WorkflowDelivery.Type;

export const WorkflowRunStatus = Schema.Literals([
  "running",
  "waiting",
  "verified",
  "stopped",
  "delivered",
]);
export type WorkflowRunStatus = typeof WorkflowRunStatus.Type;

export const WorkflowRunView = Schema.Struct({
  workId: Schema.String,
  agentIndex: Schema.Int,
  status: WorkflowRunStatus,
  detail: Schema.NullOr(Schema.String),
  routeLabel: Schema.NullOr(Schema.String),
});
export type WorkflowRunView = typeof WorkflowRunView.Type;

const ScheduledTaskWebhookSchedule = Schema.Struct({
  type: Schema.Literal("webhook").annotate({
    description: "Select webhook triggering.",
  }),
  source: Schema.optional(ScheduledTaskWebhookSource).annotate({
    description:
      "Expected sender. 'github' and 'basecamp' deliveries are normalized into a summary; other senders are rejected when set.",
  }),
  sample: Schema.optional(ScheduledTaskWebhookSample).annotate({
    description: "Saved example delivery used to test the filter and preview the prompt.",
  }),
  events: Schema.optional(Schema.Array(TrimmedNonEmptyString)).annotate({
    description:
      "Event keys that start a run, such as 'pull_request.opened', 'pull_request', 'deployment_status.success', or Basecamp 'todo_created'. Omit or leave empty to accept every event.",
  }),
  /** Dot path into the JSON body that identifies one piece of work, such as "issue.id" or "pull_request.number". */
  workKey: Schema.optional(TrimmedNonEmptyString),
  agents: Schema.optional(Schema.Array(WorkflowAgent)),
  delivery: Schema.optional(WorkflowDelivery),
}).annotate({
  description: "Never run on a timer; run once per event posted to the task's webhook URL.",
});

/**
 * Read model for persisted schedules. Keep accepting legacy sub-minute rows so
 * users can list, disable, edit, or delete them after the write minimum changes.
 */
export const ScheduledTaskSchedule = Schema.Union([
  ScheduledTaskIntervalSchedule,
  ScheduledTaskFixedTimeSchedule,
  ScheduledTaskWebhookSchedule,
]).annotate({
  description:
    "Structured schedule. Pass an object with type 'interval', 'fixed_time', or 'webhook'.",
});
export type ScheduledTaskSchedule = typeof ScheduledTaskSchedule.Type;

/** Mutation model: newly created or updated interval schedules run at most once per minute. */
export const ScheduledTaskUpsertSchedule = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("interval").annotate({
      description: "Select interval scheduling.",
    }),
    everyMs: ScheduledTaskIntervalMs.check(
      Schema.isGreaterThanOrEqualTo(MIN_SCHEDULED_TASK_INTERVAL_MS),
    ).annotate({
      description: "Interval in milliseconds, with a minimum of 60000 (one minute).",
    }),
  }).annotate({
    description: "Run repeatedly after a fixed number of milliseconds.",
  }),
  ScheduledTaskFixedTimeSchedule,
  ScheduledTaskWebhookSchedule,
]).annotate({
  description:
    "Writable schedule. Pass an object with type 'interval', 'fixed_time', or 'webhook'.",
});
export type ScheduledTaskUpsertSchedule = typeof ScheduledTaskUpsertSchedule.Type;

export const ScheduledTaskRunStatus = Schema.Literals(["never", "running", "succeeded", "failed"]);
export type ScheduledTaskRunStatus = typeof ScheduledTaskRunStatus.Type;

export const ScheduledTask = Schema.Struct({
  id: ScheduledTaskId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskSchedule,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  lastRunError: Schema.NullOr(Schema.String),
  runCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  webhookPath: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description:
      "Server-relative URL (path and token) that triggers a webhook task; null for timed tasks.",
  }),
  workflowRun: Schema.optional(Schema.NullOr(WorkflowRunView)),
  webhookUrl: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description:
      "Absolute public URL for the webhook when the server knows its public host (Tailscale Funnel or T3CODE_WEBHOOK_BASE_URL).",
  }),
});
export type ScheduledTask = typeof ScheduledTask.Type;

export const ScheduledTaskListInput = Schema.Struct({});
export type ScheduledTaskListInput = typeof ScheduledTaskListInput.Type;

export const ScheduledTaskListResult = Schema.Struct({
  tasks: Schema.Array(ScheduledTask),
});
export type ScheduledTaskListResult = typeof ScheduledTaskListResult.Type;

export const ScheduledTaskUpsertInput = Schema.Struct({
  id: Schema.optional(ScheduledTaskId),
  requireExisting: Schema.optional(Schema.Boolean).annotate({
    description: "Reject the save if the task no longer exists, for edits from a client form.",
  }),
  commandId: Schema.optional(CommandId),
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskUpsertSchedule,
  projectId: ProjectId,
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: Schema.optional(OrchestrationV2Actor),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
});
export type ScheduledTaskUpsertInput = typeof ScheduledTaskUpsertInput.Type;

/** Partial update that flips only the enabled flag — never overwrites other fields. */
export const ScheduledTaskSetEnabledInput = Schema.Struct({
  id: ScheduledTaskId,
  enabled: Schema.Boolean,
});
export type ScheduledTaskSetEnabledInput = typeof ScheduledTaskSetEnabledInput.Type;

export const ScheduledTaskDeleteInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskDeleteInput = typeof ScheduledTaskDeleteInput.Type;

export const ScheduledTaskRunNowInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskRunNowInput = typeof ScheduledTaskRunNowInput.Type;

export const ScheduledTaskMutationResult = Schema.Struct({
  task: ScheduledTask,
});
export type ScheduledTaskMutationResult = typeof ScheduledTaskMutationResult.Type;

export const ScheduledTaskDeleteResult = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskDeleteResult = typeof ScheduledTaskDeleteResult.Type;

export const ScheduledTaskRunNowResult = Schema.Struct({
  task: ScheduledTask,
});
export type ScheduledTaskRunNowResult = typeof ScheduledTaskRunNowResult.Type;

export const ScheduledTaskTestWebhookInput = Schema.Struct({
  schedule: ScheduledTaskUpsertSchedule,
  prompt: Schema.String,
  sample: ScheduledTaskWebhookSample,
  taskId: Schema.optional(ScheduledTaskId),
  run: Schema.optional(Schema.Boolean).annotate({
    description: "Start a real run of the saved task with the sample when it matches.",
  }),
});
export type ScheduledTaskTestWebhookInput = typeof ScheduledTaskTestWebhookInput.Type;

export const ScheduledTaskTestWebhookResult = Schema.Struct({
  accepted: Schema.Boolean,
  source: Schema.String,
  keys: Schema.Array(Schema.String),
  renderedPrompt: Schema.String,
  run: Schema.optional(ScheduledTask),
});
export type ScheduledTaskTestWebhookResult = typeof ScheduledTaskTestWebhookResult.Type;

export const VerifierHandoffStatus = Schema.Literals(["pending", "claimed", "running", "failed"]);
export type VerifierHandoffStatus = typeof VerifierHandoffStatus.Type;

export const VerifierHandoff = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
  taskId: ScheduledTaskId,
  status: VerifierHandoffStatus,
  branch: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  targetLabel: Schema.NullOr(Schema.String),
});
export type VerifierHandoff = typeof VerifierHandoff.Type;

export const VerifierHandoffListResult = Schema.Struct({
  handoffs: Schema.Array(VerifierHandoff),
});
export type VerifierHandoffListResult = typeof VerifierHandoffListResult.Type;

export const VerifierHandoffClaimInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type VerifierHandoffClaimInput = typeof VerifierHandoffClaimInput.Type;

export const VerifierHandoffClaimResult = Schema.Struct({
  claimed: Schema.Boolean,
});
export type VerifierHandoffClaimResult = typeof VerifierHandoffClaimResult.Type;

export const VerifierHandoffPrepareInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type VerifierHandoffPrepareInput = typeof VerifierHandoffPrepareInput.Type;

export const VerifierHandoffPrepareResult = Schema.Struct({
  branch: TrimmedNonEmptyString,
  baseRef: TrimmedNonEmptyString,
  patch: Schema.String,
  title: TrimmedNonEmptyString,
  prompt: Schema.String,
  schedule: ScheduledTaskUpsertSchedule,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sourceTaskId: ScheduledTaskId,
});
export type VerifierHandoffPrepareResult = typeof VerifierHandoffPrepareResult.Type;

export const VerifierHandoffSettleInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  status: Schema.Literals(["running", "failed"]),
  detail: Schema.optional(Schema.String),
  targetLabel: Schema.optional(Schema.String),
});
export type VerifierHandoffSettleInput = typeof VerifierHandoffSettleInput.Type;

export const VerifierHandoffSettleResult = Schema.Struct({
  ok: Schema.Boolean,
});
export type VerifierHandoffSettleResult = typeof VerifierHandoffSettleResult.Type;

export const StartVerifierRunInput = Schema.Struct({
  projectId: ProjectId,
  sourceTaskId: ScheduledTaskId,
  title: TrimmedNonEmptyString,
  prompt: Schema.String,
  schedule: ScheduledTaskUpsertSchedule,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: TrimmedNonEmptyString,
  baseRef: TrimmedNonEmptyString,
  patch: Schema.String,
  deliveryId: TrimmedNonEmptyString,
});
export type StartVerifierRunInput = typeof StartVerifierRunInput.Type;

export const StartVerifierRunResult = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  workId: TrimmedNonEmptyString,
});
export type StartVerifierRunResult = typeof StartVerifierRunResult.Type;

export class ScheduledTaskError extends Schema.TaggedError<ScheduledTaskError>()(
  "ScheduledTaskError",
  {
    message: Schema.String,
    taskId: Schema.optional(ScheduledTaskId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
