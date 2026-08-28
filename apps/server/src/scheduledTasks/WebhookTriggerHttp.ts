import {
  AutomationWebhookConflictError,
  AutomationWebhookInvalidRequestError,
  AutomationWebhookNotFoundError,
  AutomationWebhookPayloadTooLargeError,
  AutomationWebhookTriggerResult,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentHttpApi,
  type EnvironmentInternalError,
  type ScheduledTaskError,
  MAX_AUTOMATION_WEBHOOK_CONTENT_CHARS,
  MAX_AUTOMATION_WEBHOOK_FIRE_KEY_CHARS,
  MessageId,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  type AutomationWebhookTriggerRequest,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import { getAutoBootstrapDefaultModelSelection } from "../serverRuntimeStartup.ts";
import { ScheduledTaskService, withEventBlock } from "./ScheduledTaskService.ts";

/**
 * Resolved trigger intent. Validation both checks the request and resolves
 * which dispatch mode it selects, so the handler never re-checks.
 */
export type AutomationWebhookTriggerPlan =
  | { readonly mode: "task"; readonly taskId: ScheduledTaskId }
  | { readonly mode: "adhoc"; readonly prompt: string; readonly projectId: ProjectId };

export type AutomationWebhookRequestPlan =
  | { readonly ok: true; readonly plan: AutomationWebhookTriggerPlan }
  | {
      readonly ok: false;
      readonly error: AutomationWebhookInvalidRequestError | AutomationWebhookPayloadTooLargeError;
    };

/**
 * Payload- and shape-level validation. Returns the first failing HTTP error,
 * or the plan to dispatch.
 */
export function planAutomationWebhookRequest(
  request: AutomationWebhookTriggerRequest,
): AutomationWebhookRequestPlan {
  const contentChars = (request.prompt?.length ?? 0) + JSON.stringify(request.event ?? {}).length;
  if (contentChars > MAX_AUTOMATION_WEBHOOK_CONTENT_CHARS) {
    return {
      ok: false,
      error: new AutomationWebhookPayloadTooLargeError({
        code: "payload_too_large",
        message: `Webhook prompt and event content exceeds ${MAX_AUTOMATION_WEBHOOK_CONTENT_CHARS} characters.`,
      }),
    };
  }
  if (
    request.fireKey !== undefined &&
    request.fireKey.length > MAX_AUTOMATION_WEBHOOK_FIRE_KEY_CHARS
  ) {
    return {
      ok: false,
      error: new AutomationWebhookInvalidRequestError({
        code: "invalid_request",
        message: `fireKey must be at most ${MAX_AUTOMATION_WEBHOOK_FIRE_KEY_CHARS} characters.`,
      }),
    };
  }
  if (request.taskId !== undefined) {
    if (request.prompt !== undefined) {
      return {
        ok: false,
        error: new AutomationWebhookInvalidRequestError({
          code: "invalid_request",
          message: "Pass either taskId or prompt, not both.",
        }),
      };
    }
    return { ok: true, plan: { mode: "task", taskId: ScheduledTaskId.make(request.taskId) } };
  }
  if (request.prompt === undefined) {
    return {
      ok: false,
      error: new AutomationWebhookInvalidRequestError({
        code: "invalid_request",
        message: "Pass either taskId or prompt.",
      }),
    };
  }
  if (request.projectId === undefined) {
    return {
      ok: false,
      error: new AutomationWebhookInvalidRequestError({
        code: "invalid_request",
        message: "prompt requires projectId.",
      }),
    };
  }
  return {
    ok: true,
    plan: {
      mode: "adhoc",
      prompt: request.prompt,
      projectId: ProjectId.make(request.projectId),
    },
  };
}

/** Maps scheduled-task failures to the webhook's HTTP error vocabulary. */
export function mapScheduledTaskError(
  error: ScheduledTaskError,
):
  | ScheduledTaskError
  | AutomationWebhookNotFoundError
  | AutomationWebhookConflictError
  | EnvironmentInternalError {
  switch (error.reason) {
    case "not_found":
      return new AutomationWebhookNotFoundError({
        code: "not_found",
        message: error.message,
      });
    case "paused":
    case "already_running":
      return new AutomationWebhookConflictError({
        code: "conflict",
        message: error.message,
      });
    default:
      return error;
  }
}

/** The webhook trigger surface: fire saved tasks or run ad-hoc prompts by API key. */
export const automationWebhookHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "automations",
  Effect.fnUntraced(function* (handlers) {
    const scheduledTasks = yield* ScheduledTaskService;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const projects = yield* ProjectService.ProjectService;
    const crypto = yield* Crypto.Crypto;

    return handlers.handle(
      "trigger",
      Effect.fn("environment.automations.trigger")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope("automation:trigger");
        const request = args.payload;

        const requested = planAutomationWebhookRequest(request);
        if (!requested.ok) return yield* requested.error;
        const plan = requested.plan;

        // Saved-task mode.
        if (plan.mode === "task") {
          const fired = yield* scheduledTasks
            .fireTask({
              taskId: plan.taskId,
              ...(request.event === undefined ? {} : { event: request.event }),
              ...(request.fireKey === undefined ? {} : { fireKey: request.fireKey }),
            })
            .pipe(
              Effect.mapError(mapScheduledTaskError),
              Effect.catchTag("ScheduledTaskError", (error) =>
                failEnvironmentInternal("internal_error", error),
              ),
            );
          return { threadId: fired.threadId, taskId: fired.task.id };
        }

        // Ad-hoc prompt mode: launch a fresh thread in the designated project,
        // inheriting that project's model and the server's default runtime.
        const projectId = plan.projectId;
        const project = yield* projects.getById(projectId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                new AutomationWebhookNotFoundError({
                  code: "not_found",
                  message: "Project not found.",
                }),
              onSome: Effect.succeed,
            }),
          ),
          Effect.catchTag("ProjectOperationError", (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        const fireKey =
          request.fireKey ??
          `webhook:${yield* crypto.randomUUIDv4.pipe(Effect.catch(() => failEnvironmentInternal("internal_error")))}`;
        const launched = yield* threadLaunch
          .launch({
            commandId: CommandId.make(`webhook-run:${fireKey}`),
            projectId,
            title: request.title ?? "Webhook run",
            modelSelection:
              project.defaultModelSelection ?? getAutoBootstrapDefaultModelSelection(),
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            workspaceStrategy: { type: "root" },
            initialMessage: {
              messageId: MessageId.make(`webhook-run-message:${fireKey}`),
              text: withEventBlock(plan.prompt, request.event),
              attachments: [],
            },
            createdBy: "system",
            creationSource: "server",
          })
          .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        return AutomationWebhookTriggerResult.make({
          threadId: ThreadId.make(launched.threadId),
        });
      }),
    );
  }),
);
