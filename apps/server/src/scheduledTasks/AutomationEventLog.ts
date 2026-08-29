import {
  AutomationEventError,
  AutomationEventLogEntry,
  type AutomationEventListResult,
  type ProjectId,
  type ScheduledTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Deliveries older than the newest N are pruned on insert. */
export const AUTOMATION_EVENT_RETENTION = 500;

export class AutomationEventLog extends Context.Service<
  AutomationEventLog,
  {
    /**
     * Record one received delivery. Best-effort by contract: a persistence
     * failure logs a warning and never fails the trigger response it
     * accompanies.
     */
    readonly record: (input: {
      readonly outcome: "accepted" | "rejected";
      readonly httpStatus: number;
      readonly mode?: "task" | "adhoc";
      readonly taskId?: ScheduledTaskId;
      readonly projectId?: ProjectId;
      readonly threadId?: ThreadId;
      readonly fireKey?: string;
      readonly keySubject: string;
      readonly keySessionId: string;
      readonly errorCode?: string;
      readonly errorMessage?: string;
      readonly eventJson?: string;
    }) => Effect.Effect<void>;
    /** Recent deliveries, newest first, bounded by retention. */
    readonly list: () => Effect.Effect<AutomationEventListResult, AutomationEventError>;
    /** Emits the full list on subscribe and again after every recorded delivery. */
    readonly subscribeList: () => Stream.Stream<AutomationEventListResult, AutomationEventError>;
  }
>()("t3/scheduledTasks/AutomationEventLog") {}

interface AutomationEventRow {
  readonly event_id: string;
  readonly received_at: string;
  readonly outcome: string;
  readonly http_status: number;
  readonly mode: string;
  readonly task_id: string | null;
  readonly project_id: string | null;
  readonly thread_id: string | null;
  readonly fire_key: string | null;
  readonly key_subject: string;
  readonly key_session_id: string;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly event_json: string | null;
}

const decodeEntry = Schema.decodeUnknownEffect(AutomationEventLogEntry);

function iso(value: DateTime.DateTime): string {
  return DateTime.formatIso(DateTime.toUtc(value));
}

const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

const decodeRow = (row: AutomationEventRow) =>
  decodeEntry({
    id: row.event_id,
    receivedAt: row.received_at,
    outcome: row.outcome,
    httpStatus: row.http_status,
    mode: row.mode,
    taskId: row.task_id,
    projectId: row.project_id,
    threadId: row.thread_id,
    fireKey: row.fire_key,
    keySubject: row.key_subject,
    keySessionId: row.key_session_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    eventJson: row.event_json,
  }).pipe(
    Effect.mapError(
      (cause) => new AutomationEventError({ message: "Could not decode delivery.", cause }),
    ),
  );

export const layer = Layer.effect(
  AutomationEventLog,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    // Sliding(1) coalesces the dirty-signal: every notification triggers a
    // full list() re-emit anyway, so a slow subscriber only ever needs the
    // latest signal — an unbounded backlog would just grow memory.
    const changesPubSub = yield* PubSub.sliding<void>(1);
    const notifyChanged = PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid);

    const record: AutomationEventLog["Service"]["record"] = (input) =>
      Effect.gen(function* () {
        const id = yield* crypto.randomUUIDv4;
        const now = yield* localNow;
        const receivedAt = iso(now);
        yield* sql`
          INSERT INTO automation_events (
            event_id,
            received_at,
            outcome,
            http_status,
            mode,
            task_id,
            project_id,
            thread_id,
            fire_key,
            key_subject,
            key_session_id,
            error_code,
            error_message,
            event_json
          )
          VALUES (
            ${id},
            ${receivedAt},
            ${input.outcome},
            ${input.httpStatus},
            ${input.mode ?? null},
            ${input.taskId ?? null},
            ${input.projectId ?? null},
            ${input.threadId ?? null},
            ${input.fireKey ?? null},
            ${input.keySubject},
            ${input.keySessionId},
            ${input.errorCode ?? null},
            ${input.errorMessage ?? null},
            ${input.eventJson ?? null}
          )
        `;
        // Bound the log: everything beyond the newest N rows is dropped on
        // every insert, so no cron or maintenance pass is needed.
        yield* sql`
          DELETE FROM automation_events
          WHERE event_id NOT IN (
            SELECT event_id FROM automation_events
            ORDER BY rowid DESC
            LIMIT ${AUTOMATION_EVENT_RETENTION}
          )
        `;
        yield* notifyChanged;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not record automation webhook delivery", { cause }),
        ),
      );

    const list: AutomationEventLog["Service"]["list"] = () =>
      Effect.gen(function* () {
        const rows = yield* sql<AutomationEventRow>`
          SELECT
            event_id,
            received_at,
            outcome,
            http_status,
            mode,
            task_id,
            project_id,
            thread_id,
            fire_key,
            key_subject,
            key_session_id,
            error_code,
            error_message,
            event_json
          FROM automation_events
          ORDER BY rowid DESC
          LIMIT ${AUTOMATION_EVENT_RETENTION}
        `.pipe(
          Effect.mapError(
            (cause) => new AutomationEventError({ message: "Could not list deliveries.", cause }),
          ),
        );
        const events = yield* Effect.forEach(rows, decodeRow, { concurrency: 1 });
        return { events };
      });

    const subscribeList: AutomationEventLog["Service"]["subscribeList"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before taking the snapshot so a delivery landing between
          // the two is buffered by the subscription rather than dropped.
          const subscription = yield* PubSub.subscribe(changesPubSub);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
          );
        }),
      );

    return AutomationEventLog.of({ record, list, subscribeList });
  }),
);
