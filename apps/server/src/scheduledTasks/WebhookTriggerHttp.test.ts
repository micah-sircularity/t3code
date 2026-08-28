import { assert, describe, it } from "@effect/vitest";
import {
  AutomationWebhookConflictError,
  AutomationWebhookInvalidRequestError,
  AutomationWebhookNotFoundError,
  AutomationWebhookPayloadTooLargeError,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import { withEventBlock } from "./ScheduledTaskService.ts";
import { mapScheduledTaskError, planAutomationWebhookRequest } from "./WebhookTriggerHttp.ts";

const webhookTaskId = ScheduledTaskId.make("scheduled-task:webhook-test");
const webhookProjectId = ProjectId.make("project:webhook-test");
const codexModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
} as const;

describe("automation webhook request planning", () => {
  it("plans saved-task mode from taskId", () => {
    const requested = planAutomationWebhookRequest({ taskId: webhookTaskId });
    if (!requested.ok) return assert.fail("expected a valid plan");
    assert.deepEqual(requested.plan, { mode: "task", taskId: webhookTaskId });
  });

  it("plans ad-hoc mode from prompt + projectId", () => {
    const requested = planAutomationWebhookRequest({
      prompt: "Deploy the release",
      projectId: webhookProjectId,
    });
    if (!requested.ok) return assert.fail("expected a valid plan");
    assert.deepEqual(requested.plan, {
      mode: "adhoc",
      prompt: "Deploy the release",
      projectId: webhookProjectId,
    });
  });

  it("rejects requests with neither taskId nor prompt", () => {
    const requested = planAutomationWebhookRequest({});
    assert.equal(requested.ok, false);
    if (!requested.ok) {
      assert.instanceOf(requested.error, AutomationWebhookInvalidRequestError);
      assert.equal(requested.error.code, "invalid_request");
    }
  });

  it("rejects requests with both taskId and prompt", () => {
    const requested = planAutomationWebhookRequest({
      taskId: webhookTaskId,
      prompt: "Deploy the release",
      projectId: webhookProjectId,
    });
    assert.equal(requested.ok, false);
    if (!requested.ok) {
      assert.instanceOf(requested.error, AutomationWebhookInvalidRequestError);
    }
  });

  it("rejects ad-hoc prompts without a project", () => {
    const requested = planAutomationWebhookRequest({ prompt: "Deploy the release" });
    assert.equal(requested.ok, false);
    if (!requested.ok) {
      assert.match(requested.error.message, /projectId/);
    }
  });

  it("rejects oversized prompt or event content", () => {
    const requested = planAutomationWebhookRequest({
      prompt: "x".repeat(300_000),
      projectId: webhookProjectId,
    });
    assert.equal(requested.ok, false);
    if (!requested.ok) {
      assert.instanceOf(requested.error, AutomationWebhookPayloadTooLargeError);
    }
  });

  it("rejects oversized fire keys", () => {
    const requested = planAutomationWebhookRequest({
      taskId: webhookTaskId,
      fireKey: "k".repeat(257),
    });
    assert.equal(requested.ok, false);
    if (!requested.ok) {
      assert.instanceOf(requested.error, AutomationWebhookInvalidRequestError);
    }
  });
});

describe("automation webhook scheduled-task error mapping", () => {
  const taskError = (reason: "not_found" | "paused" | "already_running" | undefined) =>
    new ScheduledTaskError({ message: "failed", ...(reason === undefined ? {} : { reason }) });

  it("maps not_found to 404", () => {
    const mapped = mapScheduledTaskError(taskError("not_found"));
    assert.instanceOf(mapped, AutomationWebhookNotFoundError);
    assert.equal(mapped.code, "not_found");
  });

  it("maps paused and already_running to 409", () => {
    const paused = mapScheduledTaskError(taskError("paused"));
    assert.instanceOf(paused, AutomationWebhookConflictError);
    assert.equal(paused.code, "conflict");
    const running = mapScheduledTaskError(taskError("already_running"));
    assert.instanceOf(running, AutomationWebhookConflictError);
  });

  it("keeps unmapped task errors internal", () => {
    const mapped = mapScheduledTaskError(taskError(undefined));
    assert.equal(mapped._tag, "ScheduledTaskError");
  });
});

describe("automation webhook prompt composition", () => {
  it("appends the event as a fenced JSON block", () => {
    const composed = withEventBlock("Handle it.", { pr: 42, action: "opened" });
    assert.match(composed, /^Handle it\./);
    assert.match(composed, /\[Webhook event payload\]/);
    assert.match(composed, /"pr": 42/);
  });

  it("leaves prompts without events untouched", () => {
    assert.equal(withEventBlock("Handle it.", undefined), "Handle it.");
  });
});

describe("ScheduledTaskService.fireTask", () => {
  const launchCalls: Array<Record<string, unknown>> = [];

  const threadLaunchStubLayer = Layer.succeed(
    ThreadLaunchService.ThreadLaunchService,
    ThreadLaunchService.ThreadLaunchService.of({
      launch: (input) =>
        Effect.sync(() => {
          launchCalls.push(input as unknown as Record<string, unknown>);
          return {
            threadId: ThreadId.make(`thread:webhook-test:${launchCalls.length}`),
            // The service under test only reads threadId off the result.
            projection: null,
            resumed: false,
          } as unknown as ThreadLaunchService.ThreadLaunchResult;
        }),
    }),
  );

  const threadManagementStubLayer = Layer.succeed(ThreadManagementService.ThreadManagementService, {
    sendToThread: () => Effect.die("sendToThread is unused in webhook tests"),
  } as never);

  const serviceLayer = ScheduledTaskService.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(threadLaunchStubLayer),
    Layer.provide(threadManagementStubLayer),
  );

  it.effect("fires an enabled webhook task and reports the launched thread", () =>
    Effect.gen(function* () {
      launchCalls.length = 0;
      const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
      const upserted = yield* scheduledTasks.upsert({
        title: "Triage new issues",
        prompt: "Summarize the issue and propose a fix.",
        enabled: true,
        schedule: { type: "webhook" },
        projectId: webhookProjectId,
        workspaceStrategy: { type: "root" },
        modelSelection: codexModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      // Webhook tasks are never clock-scheduled.
      assert.equal(upserted.task.nextRunAt, null);

      const fired = yield* scheduledTasks.fireTask({
        taskId: upserted.task.id,
        event: { pr: 42, action: "opened" },
        fireKey: "delivery-1",
      });

      assert.equal(fired.threadId, "thread:webhook-test:1");
      assert.equal(fired.task.lastRunStatus, "succeeded");
      assert.equal(fired.task.runCount, 1);
      assert.equal(fired.task.nextRunAt, null);

      const launch = launchCalls[0];
      assert.ok(launch !== undefined);
      assert.equal(launch.commandId, `scheduled-task:${upserted.task.id}:webhook:delivery-1`);
      const text = (launch.initialMessage as { text: string }).text;
      assert.match(text, /\[Triggered by webhook: Triage new issues\]/);
      assert.match(text, /Summarize the issue and propose a fix\./);
      assert.match(text, /"pr": 42/);
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("refuses to fire a paused task", () =>
    Effect.gen(function* () {
      launchCalls.length = 0;
      const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
      const upserted = yield* scheduledTasks.upsert({
        title: "Paused task",
        prompt: "Never fires while paused.",
        enabled: false,
        schedule: { type: "webhook" },
        projectId: webhookProjectId,
        workspaceStrategy: { type: "root" },
        modelSelection: codexModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      const failure = yield* scheduledTasks
        .fireTask({ taskId: upserted.task.id })
        .pipe(Effect.flip);

      assert.equal(failure.reason, "paused");
      assert.equal(launchCalls.length, 0);
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("fails with not_found for unknown tasks", () =>
    Effect.gen(function* () {
      const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
      const failure = yield* scheduledTasks.fireTask({ taskId: webhookTaskId }).pipe(Effect.flip);

      assert.equal(failure.reason, "not_found");
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("keeps enabling a webhook task unscheduled", () =>
    Effect.gen(function* () {
      const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
      const upserted = yield* scheduledTasks.upsert({
        title: "Toggle target",
        prompt: "Still event-driven.",
        enabled: false,
        schedule: { type: "webhook" },
        projectId: webhookProjectId,
        workspaceStrategy: { type: "root" },
        modelSelection: codexModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      const enabled = yield* scheduledTasks.setEnabled({
        id: upserted.task.id,
        enabled: true,
      });

      assert.equal(enabled.task.enabled, true);
      assert.equal(enabled.task.nextRunAt, null);
    }).pipe(Effect.provide(serviceLayer)),
  );
});
