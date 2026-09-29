import {
  CommandId,
  MessageId,
  ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTaskDeleteInput,
  type ScheduledTaskDeleteResult,
  type ScheduledTaskListResult,
  type ScheduledTaskMutationResult,
  type ScheduledTaskRunNowInput,
  type ScheduledTaskRunNowResult,
  type ScheduledTaskTestWebhookInput,
  type ScheduledTaskTestWebhookResult,
  type ScheduledTaskSetEnabledInput,
  type WorkflowAgent,
  type WorkflowRunStatus,
  type WorkflowRunView,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { readTailscaleStatus } from "@t3tools/tailscale";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  type NormalizedWebhookEvent,
  normalizeWebhookEvent,
  renderWebhookEvent,
  webhookFilterAccepts,
} from "./WebhookEvent.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";
import {
  nextWorkflowStatus,
  routeLabel,
  verdictFromText,
  workIdFromPayload,
} from "./WorkflowRun.ts";

export const SCHEDULED_TASK_WEBHOOK_PREFIX = "/hooks";

const decodeTask = Schema.decodeUnknownEffect(ScheduledTask);
const decodeTaskId = Schema.decodeUnknownOption(ScheduledTaskId);
const decodeScheduleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.schedule),
);
const decodeWorkspaceStrategyJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.workspaceStrategy),
);
const decodeModelSelectionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.modelSelection),
);

interface ScheduledTaskRow {
  readonly task_id: string;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: number;
  readonly schedule_json: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly workspace_strategy_json: string;
  readonly model_selection_json: string;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly created_by: string;
  readonly creation_source: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly next_run_at: string | null;
  readonly last_run_at: string | null;
  readonly last_run_status: string;
  readonly last_run_error: string | null;
  readonly run_count: number;
}

export class ScheduledTaskService extends Context.Service<
  ScheduledTaskService,
  {
    readonly list: () => Effect.Effect<ScheduledTaskListResult, ScheduledTaskError>;
    /** Emits the full task list on subscribe and again after every change (CRUD, run transitions, reschedules). */
    readonly subscribeList: () => Stream.Stream<ScheduledTaskListResult, ScheduledTaskError>;
    readonly upsert: (
      input: ScheduledTaskUpsertInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    /** Partial update flipping only the enabled flag; never touches other fields. */
    readonly setEnabled: (
      input: ScheduledTaskSetEnabledInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly delete: (
      input: ScheduledTaskDeleteInput,
    ) => Effect.Effect<ScheduledTaskDeleteResult, ScheduledTaskError>;
    readonly runNow: (
      input: ScheduledTaskRunNowInput,
    ) => Effect.Effect<ScheduledTaskRunNowResult, ScheduledTaskError>;
    /**
     * Run a webhook task for one delivered event. Replays of the same
     * deliveryId resolve to the same command, so duplicate deliveries do not
     * start a second thread. Unknown ids and bad tokens both return null.
     */
    /** Dry-run a sample delivery against a schedule, optionally running the saved task. */
    readonly testWebhook: (
      input: ScheduledTaskTestWebhookInput,
    ) => Effect.Effect<ScheduledTaskTestWebhookResult, ScheduledTaskError>;
    readonly runWebhook: (input: {
      readonly id: ScheduledTaskId;
      readonly token: string;
      readonly deliveryId: string;
      readonly event: NormalizedWebhookEvent;
    }) => Effect.Effect<
      | (ScheduledTaskRunNowResult & {
          readonly skipped: boolean;
          readonly reason: "ran" | "filter" | "busy" | "waiting";
        })
      | null,
      ScheduledTaskError
    >;
  }
>()("t3/scheduledTasks/ScheduledTaskService") {}

function taskError(message: string, input?: { taskId?: ScheduledTaskId; cause?: unknown }) {
  return new ScheduledTaskError({
    message,
    ...(input?.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

export function webhookPrompt(
  prompt: string,
  deliveryId: string,
  source: string,
  text: string,
): string {
  return `${prompt}\n\n<webhook_event source="${source}" delivery="${deliveryId}">\n${text}\n</webhook_event>`;
}

function iso(value: DateTime.DateTime): string {
  return DateTime.formatIso(DateTime.toUtc(value));
}

const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

function nextRunAt(
  task: Pick<ScheduledTask, "enabled" | "schedule">,
  from: DateTime.DateTime,
): string | null {
  if (!task.enabled) return null;
  // A stored interval can decode yet overflow the representable DateTime
  // range; an unrepresentable occurrence means the task has no next run.
  try {
    const next = nextScheduledRunAt(task.schedule, from);
    return next !== null && Number.isFinite(DateTime.toEpochMillis(next)) ? iso(next) : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (Cause.isCause(error)) return Cause.pretty(error);
  if (error instanceof Error) return error.message;
  return String(error);
}

const decodeRow = (row: ScheduledTaskRow) =>
  Effect.gen(function* () {
    const schedule = yield* decodeScheduleJson(row.schedule_json);
    const workspaceStrategy = yield* decodeWorkspaceStrategyJson(row.workspace_strategy_json);
    const modelSelection = yield* decodeModelSelectionJson(row.model_selection_json);
    return yield* decodeTask({
      // The stored id decodes through the task schema so a corrupt value fails
      // as a typed parse error, not a `ScheduledTaskId.make` defect.
      id: row.task_id,
      title: row.title,
      prompt: row.prompt,
      enabled: row.enabled === 1,
      schedule,
      projectId: row.project_id,
      threadId: row.thread_id,
      workspaceStrategy,
      modelSelection,
      runtimeMode: row.runtime_mode,
      interactionMode: row.interaction_mode,
      createdBy: row.created_by,
      creationSource: row.creation_source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastRunStatus: row.last_run_status,
      lastRunError: row.last_run_error,
      runCount: row.run_count,
    });
  }).pipe(
    Effect.mapError((cause) => {
      // The typed diagnostic can only carry an id that itself decodes; a
      // corrupt stored id is omitted rather than re-thrown as a defect.
      const taskId = decodeTaskId(row.task_id);
      return taskError("Could not decode schedule task row.", {
        ...(Option.isSome(taskId) ? { taskId: taskId.value } : {}),
        cause,
      });
    }),
  );

/** Select poll candidates before decoding their schedules or other JSON payloads. */
export const listDueTasks = Effect.fn("ScheduledTaskService.listDueTasks")(function* (
  now: DateTime.DateTime,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ScheduledTaskRow>`
    SELECT * FROM scheduled_tasks
    WHERE enabled = 1 AND next_run_at IS NOT NULL
      AND next_run_at <= ${iso(now)} AND last_run_status <> 'running'
    ORDER BY next_run_at ASC, task_id ASC
  `;
  const tasks: ScheduledTask[] = [];
  for (const row of rows) {
    const decoded = yield* Effect.result(decodeRow(row));
    if (Result.isSuccess(decoded)) {
      const task = decoded.success;
      // next_run_at is a freeform string at the schema level; a stored value
      // that cannot parse as a DateTime would defect the poll below, so the
      // row is skipped here like any other corrupt row.
      if (task.nextRunAt === null || Option.isSome(DateTime.make(task.nextRunAt))) {
        tasks.push(task);
      } else {
        yield* Effect.logWarning("Skipping schedule task row with invalid next_run_at", {
          taskId: row.task_id,
        });
      }
    } else {
      yield* Effect.logWarning("Skipping undecodable schedule task row", {
        taskId: row.task_id,
        cause: decoded.failure,
      });
    }
  }
  return tasks;
});

export const layer = Layer.effect(
  ScheduledTaskService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const scheduler = yield* Scheduler.Scheduler;
    const activeRuns = yield* Ref.make<ReadonlySet<ScheduledTaskId>>(new Set());
    const maxWebhookLaunches = Math.max(
      1,
      Number(process.env.T3CODE_WEBHOOK_MAX_CONCURRENT ?? "1") || 1,
    );
    const webhookLaunches = yield* Ref.make(0);
    const launchedThreadId = yield* Ref.make<string | null>(null);
    const hostResources = yield* Effect.serviceOption(HostResources.HostResources);
    const secretStore = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
    const webhookKey = Option.isSome(secretStore)
      ? yield* secretStore.value.getOrCreateRandom("scheduled-task-webhook-key", 32)
      : randomBytes(32);
    const webhookToken = (id: ScheduledTaskId) =>
      createHmac("sha256", webhookKey).update(id).digest("base64url");
    const webhookTokenMatches = (id: ScheduledTaskId, token: string) => {
      const expected = Buffer.from(webhookToken(id));
      const actual = Buffer.from(token);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    };
    const spawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
    const configuredBase = process.env.T3CODE_WEBHOOK_BASE_URL?.trim().replace(/\/+$/u, "");
    const webhookBaseUrl =
      configuredBase !== undefined && configuredBase !== ""
        ? configuredBase
        : Option.isSome(spawner)
          ? yield* readTailscaleStatus.pipe(
              Effect.map((status) =>
                status.magicDnsName === null ? null : `https://${status.magicDnsName}`,
              ),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner.value),
              Effect.timeout("5 seconds"),
              Effect.orElseSucceed(() => null),
            )
          : null;
    const withWebhookPath = (task: ScheduledTask): ScheduledTask => {
      if (task.schedule.type !== "webhook") {
        return { ...task, webhookPath: null, webhookUrl: null };
      }
      const webhookPath = `${SCHEDULED_TASK_WEBHOOK_PREFIX}/${encodeURIComponent(task.id)}?token=${webhookToken(task.id)}`;
      return {
        ...task,
        webhookPath,
        webhookUrl: webhookBaseUrl === null ? null : `${webhookBaseUrl}${webhookPath}`,
      };
    };
    // Sliding(1) coalesces the dirty-signal: every notification triggers a
    // full list() re-emit anyway, so a slow subscriber only ever needs the
    // latest signal — an unbounded backlog would just grow memory.
    const changesPubSub = yield* PubSub.sliding<void>(1);
    const notifyChanged = PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid);

    const selectAllRows = () => sql<ScheduledTaskRow>`
      SELECT
        task_id,
        title,
        prompt,
        enabled,
        schedule_json,
        project_id,
        thread_id,
        workspace_strategy_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        created_by,
        creation_source,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        run_count
      FROM scheduled_tasks
      ORDER BY updated_at DESC, task_id ASC
    `;

    // Strict decode for the API surface: a corrupt row is a visible error.
    const listRows = Effect.fn("ScheduledTaskService.listRows")(function* () {
      const rows = yield* selectAllRows();
      return yield* Effect.forEach(rows, decodeRow, { concurrency: 1 });
    });

    const getRows = (id: ScheduledTaskId) => sql<ScheduledTaskRow>`
      SELECT
        task_id,
        title,
        prompt,
        enabled,
        schedule_json,
        project_id,
        thread_id,
        workspace_strategy_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        created_by,
        creation_source,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        run_count
      FROM scheduled_tasks
      WHERE task_id = ${id}
    `;

    /** Load a task, returning `null` when it does not exist; real load/decode failures propagate. */
    const findTask = Effect.fn("ScheduledTaskService.findTask")(function* (id: ScheduledTaskId) {
      const rows = yield* getRows(id).pipe(
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: id, cause }),
        ),
      );
      const row = rows[0];
      if (row === undefined) return null;
      return yield* decodeRow(row);
    });

    const loadTask = Effect.fn("ScheduledTaskService.loadTask")(function* (id: ScheduledTaskId) {
      const task = yield* findTask(id);
      if (task === null) {
        return yield* taskError("Schedule task not found.", { taskId: id });
      }
      return task;
    });

    // Run-state columns (last_run_*, run_count) are intentionally absent from
    // the conflict clause: they are owned by the run transitions below, and a
    // concurrent settings save must not overwrite an in-flight increment.
    // Check existence in the write itself so an edit cannot undo a deletion
    // that landed after upsert loaded the previous task.
    const saveTask = (task: ScheduledTask, requireExisting: boolean) =>
      sql<{ task_id: string }>`
        INSERT INTO scheduled_tasks (
          task_id,
          title,
          prompt,
          enabled,
          schedule_json,
          project_id,
          thread_id,
          workspace_strategy_json,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_by,
          creation_source,
          created_at,
          updated_at,
          next_run_at,
          last_run_at,
          last_run_status,
          last_run_error,
          run_count
        )
        SELECT
          ${task.id},
          ${task.title},
          ${task.prompt},
          ${task.enabled ? 1 : 0},
          ${JSON.stringify(task.schedule)},
          ${task.projectId},
          ${task.threadId},
          ${JSON.stringify(task.workspaceStrategy)},
          ${JSON.stringify(task.modelSelection)},
          ${task.runtimeMode},
          ${task.interactionMode},
          ${task.createdBy},
          ${task.creationSource},
          ${task.createdAt},
          ${task.updatedAt},
          ${task.nextRunAt},
          ${task.lastRunAt},
          ${task.lastRunStatus},
          ${task.lastRunError},
          ${task.runCount}
        WHERE ${requireExisting ? 0 : 1} = 1
           OR EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${task.id})
        ON CONFLICT (task_id)
        DO UPDATE SET
          title = excluded.title,
          prompt = excluded.prompt,
          enabled = excluded.enabled,
          schedule_json = excluded.schedule_json,
          project_id = excluded.project_id,
          thread_id = excluded.thread_id,
          workspace_strategy_json = excluded.workspace_strategy_json,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          creation_source = excluded.creation_source,
          updated_at = excluded.updated_at,
          next_run_at = excluded.next_run_at
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not save schedule task.", { taskId: task.id, cause }),
        ),
        Effect.flatMap((rows) =>
          rows.length > 0
            ? Effect.void
            : taskError("Schedule task not found.", { taskId: task.id }),
        ),
      );

    const deleteRow = (id: ScheduledTaskId) =>
      sql`DELETE FROM scheduled_tasks WHERE task_id = ${id}`.pipe(
        Effect.mapError((cause) =>
          taskError("Could not delete schedule task.", { taskId: id, cause }),
        ),
      );

    // Run-state transitions use targeted UPDATEs (never the full-row upsert) so
    // a completing run cannot resurrect a deleted task or clobber concurrent
    // edits to the task definition.
    const markRunning = (id: ScheduledTaskId, startedAtIso: string) =>
      sql`
        UPDATE scheduled_tasks
        SET updated_at = ${startedAtIso},
            last_run_at = ${startedAtIso},
            last_run_status = 'running',
            last_run_error = NULL
        WHERE task_id = ${id}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not mark schedule task as running.", { taskId: id, cause }),
        ),
      );

    const markCompleted = (input: {
      readonly id: ScheduledTaskId;
      readonly completedAtIso: string;
      readonly nextRunAtIso: string | null;
      readonly status: "succeeded" | "failed";
      readonly error: string | null;
      readonly startedAtIso: string;
    }) =>
      sql`
        UPDATE scheduled_tasks
        SET updated_at = ${input.completedAtIso},
            next_run_at = ${input.nextRunAtIso},
            last_run_status = ${input.status},
            last_run_error = ${input.error},
            run_count = run_count + 1
        WHERE task_id = ${input.id}
          AND last_run_status = 'running'
          AND last_run_at = ${input.startedAtIso}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not record schedule task run.", { taskId: input.id, cause }),
        ),
      );

    // Best-effort escape hatch: if anything fails between markRunning and
    // markCompleted, write a full terminal record so runDueTasks neither skips
    // the task forever (it filters out 'running' rows) nor re-fires it
    // immediately: the dispatch may already have gone out, so next_run_at must
    // advance and run_count must count the attempt.
    const releaseStuckRun = (task: ScheduledTask, message: string) =>
      Effect.gen(function* () {
        const now = yield* localNow;
        // Compute the next occurrence from the current row so a schedule
        // edited while the run was in flight is honoured; fall back to the
        // run's snapshot only if the re-read itself fails.
        const reread = yield* Effect.result(findTask(task.id));
        if (Result.isSuccess(reread) && reread.success === null) return; // deleted — nothing to release
        const source = Result.isSuccess(reread) && reread.success !== null ? reread.success : task;
        yield* sql`
          UPDATE scheduled_tasks
          SET last_run_status = 'failed',
              last_run_error = ${message},
              next_run_at = ${nextRunAt(source, now)},
              updated_at = ${iso(now)},
              run_count = run_count + 1
          WHERE task_id = ${task.id} AND last_run_status = 'running'
        `;
        yield* notifyChanged;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not release stuck schedule task run", {
            taskId: task.id,
            cause,
          }),
        ),
      );

    const runTask = Effect.fn("ScheduledTaskService.runTask")(function* (
      task: ScheduledTask,
      trigger: "scheduled" | "manual" | "webhook",
      event?: {
        readonly deliveryId: string;
        readonly source: string;
        readonly text: string;
        readonly prompt?: string;
        readonly title?: string;
        readonly agentIndex?: number;
        readonly modelSelection?: ScheduledTask["modelSelection"];
      },
    ) {
      // Events arrive independently, so webhook runs overlap instead of
      // queueing behind the per-task lock.
      const reserved =
        trigger === "webhook"
          ? true
          : yield* Ref.modify(activeRuns, (active) => {
              if (active.has(task.id)) return [false, active] as const;
              const next = new Set(active);
              next.add(task.id);
              return [true, next] as const;
            });
      if (!reserved) {
        if (trigger === "manual") {
          return yield* taskError("Schedule task is already running.", { taskId: task.id });
        }
        return task;
      }

      return yield* Effect.gen(function* () {
        const startedAt = yield* localNow;
        const startedAtIso = iso(startedAt);

        // The in-memory snapshot may be stale: re-read before touching run
        // state. The task may have been deleted, paused, or postponed since
        // the poll loaded it — none of those may fire.
        const active = yield* findTask(task.id);
        if (active === null) {
          // A manual run on a just-deleted task must fail loudly, not report
          // a successful run that never dispatched.
          if (trigger !== "scheduled") {
            return yield* taskError("Schedule task not found.", { taskId: task.id });
          }
          return task;
        }
        // A next_run_at corrupted between the poll read and this re-read must
        // not defect the poll; an unparseable value is treated as not due.
        const parsedNextRunAt =
          active.nextRunAt === null ? Option.none() : DateTime.make(active.nextRunAt);
        if (
          trigger === "scheduled" &&
          (!active.enabled ||
            Option.isNone(parsedNextRunAt) ||
            DateTime.toEpochMillis(parsedNextRunAt.value) > DateTime.toEpochMillis(startedAt))
        ) {
          return active;
        }

        yield* markRunning(active.id, startedAtIso);
        yield* notifyChanged;

        const fireKey =
          event === undefined
            ? `${active.id}:${DateTime.toEpochMillis(startedAt)}:${trigger}`
            : `${active.id}:webhook:${event.deliveryId}:${event.agentIndex ?? 0}`;
        const commandId = CommandId.make(`scheduled-task:${fireKey}`);
        const messageId = MessageId.make(`scheduled-task-message:${fireKey}`);
        // Dispatch from the fresh row so prompt/model/binding edits made
        // after the poll read are honoured. A verification agent can replace
        // the task prompt for this launch only.
        const modelSelection = event?.modelSelection ?? active.modelSelection;
        const promptText = event?.prompt ?? active.prompt;
        const prompt =
          event === undefined
            ? promptText
            : webhookPrompt(promptText, event.deliveryId, event.source, event.text);

        // Effect.exit (not Effect.result) so defects and interruptions in the
        // dispatch are also captured and recorded as a failed run instead of
        // aborting before markCompleted.
        const result =
          active.threadId === null
            ? yield* Effect.exit(
                threadLaunch.launch({
                  commandId,
                  projectId: active.projectId,
                  title: event?.title ?? active.title,
                  modelSelection,
                  runtimeMode: active.runtimeMode,
                  interactionMode: active.interactionMode,
                  workspaceStrategy: active.workspaceStrategy,
                  initialMessage: {
                    messageId,
                    scheduledTaskId: active.id,
                    text: prompt,
                    attachments: [],
                  },
                  createdBy: active.createdBy,
                  creationSource: active.creationSource,
                }),
              )
            : yield* Effect.exit(
                threadManagement.sendToThread({
                  projectId: active.projectId,
                  commandId,
                  threadId: ThreadId.make(active.threadId),
                  messageId,
                  scheduledTaskId: active.id,
                  text: prompt,
                  attachments: [],
                  modelSelection,
                  mode: "auto",
                  createdBy: active.createdBy,
                  creationSource: active.creationSource,
                }),
              );

        if (result._tag === "Success" && trigger === "webhook" && "threadId" in result.value) {
          yield* Ref.set(launchedThreadId, String(result.value.threadId));
        }

        const completedAt = yield* localNow;
        const runSucceeded = result._tag === "Success";
        const lastRunStatus = runSucceeded ? ("succeeded" as const) : ("failed" as const);
        const lastRunError = runSucceeded ? null : errorMessage(result.cause);
        // Re-read the task so the next run is computed from the schedule as it
        // is *now* (the user may have edited or deleted it while we ran).
        const current = yield* findTask(task.id);
        const scheduleSource = current ?? task;
        const completed: ScheduledTask = {
          ...scheduleSource,
          updatedAt: iso(completedAt),
          lastRunAt: startedAtIso,
          nextRunAt: nextRunAt(scheduleSource, completedAt),
          lastRunStatus,
          lastRunError,
          runCount: scheduleSource.runCount + 1,
        };
        if (current !== null) {
          // startedAtIso in the guard ensures this writes only to the row this
          // run marked as running — a task deleted mid-run and recreated with
          // the same id (idempotent commandId replay) must not be stamped.
          yield* markCompleted({
            id: task.id,
            completedAtIso: completed.updatedAt,
            nextRunAtIso: completed.nextRunAt,
            status: lastRunStatus,
            error: lastRunError,
            startedAtIso,
          });
          yield* notifyChanged;
        }
        return completed;
      }).pipe(
        Effect.onError((cause) => releaseStuckRun(task, errorMessage(cause))),
        Effect.ensuring(
          trigger === "webhook"
            ? Effect.void
            : Ref.update(activeRuns, (active) => {
                const next = new Set(active);
                next.delete(task.id);
                return next;
              }),
        ),
      );
    });

    // A due fixed-time run that is long past its slot (server was off or
    // asleep) is skipped and re-aimed at its next occurrence, not fired late.
    const rescheduleMissedRun = Effect.fn("ScheduledTaskService.rescheduleMissedRun")(function* (
      task: ScheduledTask,
      now: DateTime.DateTime,
    ) {
      const next = nextRunAt(task, now);
      yield* Effect.logInfo("Skipping missed schedule task run", {
        taskId: task.id,
        missedRunAt: task.nextRunAt,
        rescheduledTo: next,
      });
      yield* sql`
        UPDATE scheduled_tasks
        SET next_run_at = ${next},
            updated_at = ${iso(now)}
        WHERE task_id = ${task.id}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not reschedule missed schedule task run.", { taskId: task.id, cause }),
        ),
      );
      yield* notifyChanged;
    });

    type WorkflowRow = {
      readonly run_key: string;
      readonly task_id: string;
      readonly work_id: string;
      readonly agent_index: number;
      readonly status: string;
      readonly thread_id: string | null;
      readonly last_delivery_id: string | null;
      readonly detail: string | null;
      readonly route_label: string | null;
    };

    const workflowRunKey = (taskId: string, workId: string) => `${taskId}\u0000${workId}`;

    const readWorkflowRun = (taskId: string, workId: string) =>
      sql<WorkflowRow>`
        SELECT run_key, task_id, work_id, agent_index, status, thread_id, last_delivery_id, detail, route_label
        FROM workflow_runs
        WHERE run_key = ${workflowRunKey(taskId, workId)}
      `.pipe(Effect.map((rows) => rows[0] ?? null));

    const writeWorkflowRun = (row: {
      readonly taskId: string;
      readonly workId: string;
      readonly agentIndex: number;
      readonly status: WorkflowRunStatus;
      readonly threadId: string | null;
      readonly deliveryId: string;
      readonly detail: string | null;
      readonly routeLabel: string | null;
      readonly updatedAt: string;
    }) =>
      sql`
        INSERT INTO workflow_runs (
          run_key, task_id, work_id, agent_index, status, thread_id, last_delivery_id, detail, route_label, updated_at
        ) VALUES (
          ${workflowRunKey(row.taskId, row.workId)},
          ${row.taskId},
          ${row.workId},
          ${row.agentIndex},
          ${row.status},
          ${row.threadId},
          ${row.deliveryId},
          ${row.detail},
          ${row.routeLabel},
          ${row.updatedAt}
        )
        ON CONFLICT (run_key) DO UPDATE SET
          agent_index = excluded.agent_index,
          status = excluded.status,
          thread_id = excluded.thread_id,
          last_delivery_id = excluded.last_delivery_id,
          detail = excluded.detail,
          route_label = excluded.route_label,
          updated_at = excluded.updated_at
      `;

    const localMachineBusy = Effect.fn("ScheduledTaskService.localMachineBusy")(function* () {
      if (Option.isNone(hostResources)) return false;
      const snapshot = yield* hostResources.value.read.pipe(Effect.orElseSucceed(() => null));
      if (snapshot === null) return false;
      const memoryFull =
        snapshot.totalMemoryBytes > 0 &&
        snapshot.availableMemoryBytes / snapshot.totalMemoryBytes <= 0.05;
      const cpuFull = snapshot.cpuUtilization !== null && snapshot.cpuUtilization >= 0.95;
      return memoryFull || cpuFull;
    });

    const acquireWebhookSlot = () =>
      Ref.modify(webhookLaunches, (count) =>
        count >= maxWebhookLaunches ? ([false, count] as const) : ([true, count + 1] as const),
      );
    const releaseWebhookSlot = () => Ref.update(webhookLaunches, (count) => Math.max(0, count - 1));

    const launchWorkflowAgent = (
      task: ScheduledTask,
      agent: WorkflowAgent,
      agentIndex: number,
      event: { readonly deliveryId: string; readonly source: string; readonly text: string },
    ) =>
      Effect.gen(function* () {
        if (yield* localMachineBusy()) return { launched: false as const };
        if (!(yield* acquireWebhookSlot())) return { launched: false as const };
        yield* Ref.set(launchedThreadId, null);
        const prompt = `${agent.prompt}\n\nEnd your last line with VERIFIED if the next step should run, or STOP if it should not.`;
        const launched = yield* runTask(task, "webhook", {
          ...event,
          prompt,
          title: `${task.title} · ${agent.name}`,
          agentIndex,
          ...(agent.modelSelection === undefined ? {} : { modelSelection: agent.modelSelection }),
        }).pipe(Effect.ensuring(releaseWebhookSlot()));
        return {
          launched: true as const,
          task: launched,
          threadId: yield* Ref.get(launchedThreadId),
        };
      });

    const runDueTasks = Effect.fn("ScheduledTaskService.runDueTasks")(function* () {
      const now = yield* localNow;
      const tasks = yield* listDueTasks(now).pipe(
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );
      const due = tasks.flatMap((task) =>
        task.nextRunAt === null ? [] : [{ task, dueAt: DateTime.makeUnsafe(task.nextRunAt) }],
      );
      yield* Effect.forEach(
        due,
        ({ task, dueAt }) =>
          (isMissedFixedTimeRun(task.schedule, dueAt, now)
            ? rescheduleMissedRun(task, now)
            : runTask(task, "scheduled")
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Scheduled task run failed", { taskId: task.id, cause }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
      yield* advanceContinuingWorkflows().pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not advance verification runs", { cause }),
        ),
      );
    });

    // Recover from a crash or hard shutdown mid-run: rows stuck in 'running'
    // would otherwise be skipped by the due-task filter forever. The dispatch
    // may already have gone out before the crash, so next_run_at must advance
    // and run_count must count the attempt — otherwise the first poll after
    // every restart re-fires the interrupted task (same rationale as
    // releaseStuckRun). Schedules are JSON, so this is per-row Effect work
    // rather than a single UPDATE.
    yield* Effect.gen(function* () {
      const rows = yield* selectAllRows();
      const stuck = rows.filter((row) => row.last_run_status === "running");
      if (stuck.length === 0) return;
      const now = yield* localNow;
      yield* Effect.forEach(
        stuck,
        (row) =>
          Effect.gen(function* () {
            const decoded = yield* Effect.result(decodeRow(row));
            if (Result.isSuccess(decoded)) {
              yield* sql`
                UPDATE scheduled_tasks
                SET last_run_status = 'failed',
                    last_run_error = 'Run was interrupted by a server restart.',
                    next_run_at = ${nextRunAt(decoded.success, now)},
                    updated_at = ${iso(now)},
                    run_count = run_count + 1
                WHERE task_id IS ${row.task_id} AND last_run_status = 'running'
              `;
              return;
            }
            // The schedule cannot be decoded, so the next occurrence cannot
            // be computed — still release the row so it is not stuck in
            // 'running' (the lenient poller skips it, so it cannot re-fire).
            yield* Effect.logWarning(
              "Recovering undecodable schedule task row without rescheduling",
              { taskId: row.task_id, cause: decoded.failure },
            );
            yield* sql`
              UPDATE scheduled_tasks
              SET last_run_status = 'failed',
                  last_run_error = 'Run was interrupted by a server restart.',
                  updated_at = ${iso(now)},
                  run_count = run_count + 1
              WHERE task_id IS ${row.task_id} AND last_run_status = 'running'
            `;
          }),
        { concurrency: 1, discard: true },
      );
      yield* notifyChanged;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not reset interrupted schedule task runs", { cause }),
      ),
    );

    const workflowView = (row: WorkflowRow): WorkflowRunView | null => {
      if (
        row.status !== "running" &&
        row.status !== "waiting" &&
        row.status !== "verified" &&
        row.status !== "stopped" &&
        row.status !== "delivered"
      ) {
        return null;
      }
      return {
        workId: row.work_id,
        agentIndex: row.agent_index,
        status: row.status,
        detail: row.detail,
        routeLabel: row.route_label,
      };
    };

    const latestWorkflowRuns = Effect.fn("ScheduledTaskService.latestWorkflowRuns")(function* () {
      const rows = yield* sql<WorkflowRow>`
        SELECT run_key, task_id, work_id, agent_index, status, thread_id, last_delivery_id, detail, route_label
        FROM workflow_runs
        ORDER BY updated_at DESC
      `;
      const byTask = new Map<string, WorkflowRunView>();
      for (const row of rows) {
        if (byTask.has(row.task_id)) continue;
        const view = workflowView(row);
        if (view !== null) byTask.set(row.task_id, view);
      }
      return byTask;
    });

    const advanceContinuingWorkflows = Effect.fn("ScheduledTaskService.advanceContinuingWorkflows")(
      function* () {
        const rows = yield* sql<WorkflowRow>`
        SELECT run_key, task_id, work_id, agent_index, status, thread_id, last_delivery_id, detail, route_label
        FROM workflow_runs
        WHERE status = 'running' AND thread_id IS NOT NULL
      `;
        yield* Effect.forEach(
          rows,
          (row) =>
            Effect.gen(function* () {
              if (row.thread_id === null) return;
              const messages = yield* sql<{
                readonly role: string;
                readonly text: string;
                readonly is_streaming: number;
              }>`
              SELECT role, text, is_streaming
              FROM projection_thread_messages
              WHERE thread_id = ${row.thread_id}
              ORDER BY created_at DESC
              LIMIT 1
            `;
              const latest = messages[0];
              if (
                latest === undefined ||
                latest.role !== "assistant" ||
                latest.is_streaming !== 0
              ) {
                return;
              }
              const task = yield* findTask(ScheduledTaskId.make(row.task_id));
              if (task === null || task.schedule.type !== "webhook") return;
              const agents = task.schedule.agents ?? [];
              const agent = agents[row.agent_index];
              if (agent === undefined) return;
              const verdict = verdictFromText(latest.text);
              const advance = agent.advance ?? "wait";
              const status = nextWorkflowStatus({
                agentIndex: row.agent_index,
                agentCount: agents.length,
                advance,
                verdict,
              });
              const now = iso(yield* localNow);
              if (status !== "verified") {
                yield* writeWorkflowRun({
                  taskId: row.task_id,
                  workId: row.work_id,
                  agentIndex: row.agent_index,
                  status,
                  threadId: row.thread_id,
                  deliveryId: row.last_delivery_id ?? "",
                  detail:
                    verdict === "stopped"
                      ? "Stopped"
                      : status === "delivered"
                        ? "Delivered"
                        : "Waiting for a later event",
                  routeLabel: row.route_label,
                  updatedAt: now,
                });
                yield* notifyChanged;
                return;
              }
              const nextAgent = agents[row.agent_index + 1];
              if (nextAgent === undefined) return;
              const launch = yield* launchWorkflowAgent(task, nextAgent, row.agent_index + 1, {
                deliveryId: `${row.last_delivery_id ?? row.work_id}:next`,
                source: "workflow",
                text: latest.text,
              });
              if (!launch.launched) return;
              yield* writeWorkflowRun({
                taskId: row.task_id,
                workId: row.work_id,
                agentIndex: row.agent_index + 1,
                status: launch.task.lastRunStatus === "failed" ? "stopped" : "running",
                threadId: launch.threadId,
                deliveryId: row.last_delivery_id ?? "",
                detail: launch.task.lastRunError,
                routeLabel: routeLabel(nextAgent),
                updatedAt: iso(yield* localNow),
              });
              yield* notifyChanged;
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not advance one verification run", {
                  runKey: row.run_key,
                  cause,
                }),
              ),
            ),
          { concurrency: 1, discard: true },
        );
      },
    );

    yield* scheduler.register("scheduled-tasks", runDueTasks());

    const list: ScheduledTaskService["Service"]["list"] = () =>
      Effect.gen(function* () {
        const tasks = yield* listRows();
        const runs = yield* latestWorkflowRuns().pipe(Effect.orElseSucceed(() => new Map()));
        return {
          tasks: tasks.map((task) => ({
            ...withWebhookPath(task),
            workflowRun: runs.get(task.id) ?? null,
          })),
        };
      }).pipe(Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })));

    const subscribeList: ScheduledTaskService["Service"]["subscribeList"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before taking the snapshot so a change landing between
          // the two is buffered by the subscription rather than dropped.
          const subscription = yield* PubSub.subscribe(changesPubSub);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
          );
        }),
      );

    const upsert: ScheduledTaskService["Service"]["upsert"] = (input) =>
      Effect.gen(function* () {
        const now = yield* localNow;
        const uuid =
          input.commandId === undefined
            ? yield* crypto.randomUUIDv4.pipe(
                Effect.mapError((cause) =>
                  taskError("Could not generate schedule task id.", { cause }),
                ),
              )
            : null;
        const id =
          input.id ??
          ScheduledTaskId.make(
            input.commandId ? `scheduled-task:${input.commandId}` : `scheduled-task:${uuid}`,
          );
        // Look up by the *resolved* id so idempotent creates (commandId replays)
        // keep their run history, and so real load failures propagate instead
        // of silently resetting an existing row.
        const existingTask = yield* findTask(id);
        // Keep the existing next_run_at when the schedule itself is untouched:
        // editing a title or prompt must not postpone (or resurrect) a due
        // run — only schedule/enabled changes restart the clock.
        const scheduleUnchanged =
          existingTask !== null &&
          existingTask.enabled === input.enabled &&
          isSameSchedule(existingTask.schedule, input.schedule);
        const task: ScheduledTask = {
          id,
          title: input.title,
          prompt: input.prompt,
          enabled: input.enabled,
          schedule: input.schedule,
          projectId: input.projectId,
          threadId: input.threadId ?? null,
          workspaceStrategy: input.workspaceStrategy,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          createdBy: existingTask?.createdBy ?? input.createdBy ?? "user",
          creationSource: input.creationSource ?? "web",
          createdAt: existingTask?.createdAt ?? iso(now),
          updatedAt: iso(now),
          nextRunAt: scheduleUnchanged
            ? existingTask.nextRunAt
            : nextRunAt({ enabled: input.enabled, schedule: input.schedule }, now),
          lastRunAt: existingTask?.lastRunAt ?? null,
          lastRunStatus: existingTask?.lastRunStatus ?? "never",
          lastRunError: existingTask?.lastRunError ?? null,
          runCount: existingTask?.runCount ?? 0,
        };
        yield* saveTask(task, input.requireExisting === true);
        yield* notifyChanged;
        return { task: withWebhookPath(task) };
      });

    const setEnabled: ScheduledTaskService["Service"]["setEnabled"] = (input) =>
      Effect.gen(function* () {
        const existing = yield* loadTask(input.id);
        if (existing.enabled === input.enabled) return { task: existing };
        const now = yield* localNow;
        const next = nextRunAt({ enabled: input.enabled, schedule: existing.schedule }, now);
        // RETURNING so a task deleted between the load and this UPDATE is a
        // visible not-found error, not a false success.
        const updated = yield* sql<{ task_id: string }>`
          UPDATE scheduled_tasks
          SET enabled = ${input.enabled ? 1 : 0},
              next_run_at = ${next},
              updated_at = ${iso(now)}
          WHERE task_id = ${input.id}
          RETURNING task_id
        `.pipe(
          Effect.mapError((cause) =>
            taskError("Could not update schedule task.", { taskId: input.id, cause }),
          ),
        );
        if (updated.length === 0) {
          return yield* taskError("Schedule task not found.", { taskId: input.id });
        }
        yield* notifyChanged;
        return {
          task: { ...existing, enabled: input.enabled, nextRunAt: next, updatedAt: iso(now) },
        };
      });

    const deleteTask: ScheduledTaskService["Service"]["delete"] = (input) =>
      deleteRow(input.id).pipe(Effect.andThen(notifyChanged), Effect.as({ id: input.id }));

    const runNow: ScheduledTaskService["Service"]["runNow"] = (input: ScheduledTaskRunNowInput) =>
      Effect.gen(function* () {
        const task = yield* loadTask(input.id);
        const next = yield* runTask(task, "manual").pipe(
          Effect.mapError((cause) =>
            taskError("Could not run schedule task.", { taskId: input.id, cause }),
          ),
        );
        return { task: next };
      });

    const runWebhook: ScheduledTaskService["Service"]["runWebhook"] = (input) =>
      Effect.gen(function* () {
        const task = yield* findTask(input.id);
        if (task === null || !webhookTokenMatches(task.id, input.token)) return null;
        if (task.schedule.type !== "webhook") return null;
        if (!task.enabled) {
          return yield* taskError("Webhook task is paused.", { taskId: task.id });
        }
        if (!webhookFilterAccepts(task.schedule, input.event)) {
          return { task: withWebhookPath(task), skipped: true, reason: "filter" as const };
        }
        const agents = task.schedule.agents ?? [];
        const eventText = renderWebhookEvent(input.event);
        const source = input.event.keys[0] ?? input.event.source;
        if (agents.length === 0) {
          if ((yield* localMachineBusy()) || !(yield* acquireWebhookSlot())) {
            return { task: withWebhookPath(task), skipped: true, reason: "busy" as const };
          }
          const next = yield* runTask(task, "webhook", {
            deliveryId: input.deliveryId,
            source,
            text: eventText,
          }).pipe(
            Effect.ensuring(releaseWebhookSlot()),
            Effect.mapError((cause) =>
              taskError("Could not run webhook task.", { taskId: input.id, cause }),
            ),
          );
          return { task: withWebhookPath(next), skipped: false, reason: "ran" as const };
        }
        const workId =
          workIdFromPayload(input.event.raw, task.schedule.workKey) ??
          workIdFromPayload(input.event.raw, "pull_request.number") ??
          workIdFromPayload(input.event.raw, "issue.id") ??
          input.deliveryId;
        const current = yield* readWorkflowRun(task.id, workId);
        if (current?.last_delivery_id === input.deliveryId) {
          return { task: withWebhookPath(task), skipped: true, reason: "waiting" as const };
        }
        if (current?.status === "running") {
          return { task: withWebhookPath(task), skipped: true, reason: "busy" as const };
        }
        const agentIndex =
          current === null || current.status === "delivered" || current.status === "stopped"
            ? 0
            : current.status === "waiting"
              ? current.agent_index + 1
              : current.agent_index;
        const agent = agents[agentIndex];
        if (agent === undefined) {
          const now = iso(yield* localNow);
          yield* writeWorkflowRun({
            taskId: task.id,
            workId,
            agentIndex: agents.length - 1,
            status: "delivered",
            threadId: current?.thread_id ?? null,
            deliveryId: input.deliveryId,
            detail: task.schedule.delivery?.summary ?? "Delivered",
            routeLabel: current?.route_label ?? null,
            updatedAt: now,
          });
          return { task: withWebhookPath(task), skipped: true, reason: "waiting" as const };
        }
        const launch = yield* launchWorkflowAgent(task, agent, agentIndex, {
          deliveryId: input.deliveryId,
          source,
          text: eventText,
        }).pipe(
          Effect.mapError((cause) =>
            taskError("Could not run webhook task.", { taskId: input.id, cause }),
          ),
        );
        if (!launch.launched) {
          return { task: withWebhookPath(task), skipped: true, reason: "busy" as const };
        }
        const now = iso(yield* localNow);
        const failed = launch.task.lastRunStatus === "failed";
        yield* writeWorkflowRun({
          taskId: task.id,
          workId,
          agentIndex,
          status: failed ? "stopped" : "running",
          threadId: launch.threadId,
          deliveryId: input.deliveryId,
          detail: failed ? launch.task.lastRunError : routeLabel(agent),
          routeLabel: routeLabel(agent),
          updatedAt: now,
        });
        yield* notifyChanged;
        const workflowRun: WorkflowRunView = {
          workId,
          agentIndex,
          status: failed ? "stopped" : "running",
          detail: failed ? launch.task.lastRunError : routeLabel(agent),
          routeLabel: routeLabel(agent),
        };
        const taskResult: ScheduledTask = { ...withWebhookPath(launch.task), workflowRun };
        return { task: taskResult, skipped: false, reason: "ran" as const };
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(ScheduledTaskError)(cause)
            ? cause
            : new ScheduledTaskError({
                message: "Could not run webhook task.",
                taskId: input.id,
                cause,
              }),
        ),
      );

    const testWebhook: ScheduledTaskService["Service"]["testWebhook"] = (input) =>
      Effect.gen(function* () {
        if (input.schedule.type !== "webhook") {
          return yield* taskError("Only webhook tasks can be tested with a sample.");
        }
        const event = normalizeWebhookEvent({
          headers: Object.fromEntries(
            Object.entries(input.sample.headers ?? {}).map(([key, value]) => [
              key.toLowerCase(),
              value,
            ]),
          ),
          body: input.sample.body,
          sourceHint: input.sample.headers?.["x-webhook-source"] ?? null,
        });
        const accepted = webhookFilterAccepts(input.schedule, event);
        const now = yield* localNow;
        const deliveryId = `test:${DateTime.toEpochMillis(now)}`;
        const source = event.keys[0] ?? event.source;
        const result = {
          accepted,
          source: event.source,
          keys: [...event.keys],
          renderedPrompt: webhookPrompt(
            input.prompt,
            deliveryId,
            source,
            renderWebhookEvent(event),
          ),
        };
        if (!input.run || !accepted) return result;
        if (input.taskId === undefined) {
          return yield* taskError("Save the task before running it with a sample.");
        }
        const task = yield* loadTask(input.taskId);
        const next = yield* runTask(task, "webhook", {
          deliveryId,
          source,
          text: renderWebhookEvent(event),
        }).pipe(
          Effect.mapError((cause) =>
            taskError("Could not run webhook task.", { taskId: task.id, cause }),
          ),
        );
        return { ...result, run: withWebhookPath(next) };
      });

    return ScheduledTaskService.of({
      testWebhook,
      list,
      subscribeList,
      upsert,
      setEnabled,
      delete: deleteTask,
      runNow,
      runWebhook,
    });
  }),
);
