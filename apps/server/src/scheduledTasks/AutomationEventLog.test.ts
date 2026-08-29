import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as AutomationEventLog from "./AutomationEventLog.ts";

const serviceLayer = AutomationEventLog.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(NodeCrypto.layer),
);

const acceptedDelivery = {
  outcome: "accepted" as const,
  httpStatus: 202,
  mode: "task" as const,
  taskId: ScheduledTaskId.make("scheduled-task:evt"),
  threadId: ThreadId.make("thread:evt"),
  fireKey: "delivery-1",
  keySubject: "one-time-token",
  keySessionId: "session:1",
  eventJson: '{"action":"opened"}',
};

describe("AutomationEventLog", () => {
  it.effect("round-trips a recorded delivery", () =>
    Effect.gen(function* () {
      const log = yield* AutomationEventLog.AutomationEventLog;
      yield* log.record(acceptedDelivery);

      const { events } = yield* log.list();
      assert.equal(events.length, 1);
      const entry = events[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.outcome, "accepted");
      assert.equal(entry.httpStatus, 202);
      assert.equal(entry.mode, "task");
      assert.equal(entry.taskId, "scheduled-task:evt");
      assert.equal(entry.threadId, "thread:evt");
      assert.equal(entry.fireKey, "delivery-1");
      assert.equal(entry.eventJson, '{"action":"opened"}');
      assert.equal(entry.projectId, null);
      assert.equal(entry.errorCode, null);
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("prunes deliveries beyond the retention window", () =>
    Effect.gen(function* () {
      const log = yield* AutomationEventLog.AutomationEventLog;
      for (let index = 0; index < 510; index += 1) {
        yield* log.record({
          outcome: "rejected",
          httpStatus: 409,
          mode: "task",
          taskId: ScheduledTaskId.make("scheduled-task:evt"),
          keySubject: "one-time-token",
          keySessionId: "session:1",
          errorCode: "AutomationWebhookConflictError",
          errorMessage: `run ${index}`,
        });
      }

      const { events } = yield* log.list();
      assert.equal(events.length, AutomationEventLog.AUTOMATION_EVENT_RETENTION);
      // Newest first: the most recent rejection leads, the earliest are gone.
      assert.equal(events[0]?.errorMessage, "run 509");
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("records rejected deliveries with their outcome", () =>
    Effect.gen(function* () {
      const log = yield* AutomationEventLog.AutomationEventLog;
      yield* log.record({
        outcome: "rejected",
        httpStatus: 404,
        mode: "adhoc",
        projectId: ProjectId.make("project:missing"),
        keySubject: "one-time-token",
        keySessionId: "session:1",
        errorCode: "AutomationWebhookNotFoundError",
        errorMessage: "Project not found.",
      });

      const { events } = yield* log.list();
      const entry = events[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.outcome, "rejected");
      assert.equal(entry.httpStatus, 404);
      assert.equal(entry.threadId, null);
      assert.equal(entry.errorCode, "AutomationWebhookNotFoundError");
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("pushes a fresh list to subscribers after every delivery", () =>
    Effect.gen(function* () {
      const log = yield* AutomationEventLog.AutomationEventLog;
      const updatesFiber = yield* log
        .subscribeList()
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* log.record(acceptedDelivery);

      const collected = Array.from(yield* Fiber.join(updatesFiber));
      assert.equal(collected.length, 2);
      const second = collected[1];
      assert.ok(second !== undefined);
      assert.equal(second.events.length, 1);
      assert.equal(second.events[0]?.outcome, "accepted");
    }).pipe(Effect.provide(serviceLayer)),
  );
});
