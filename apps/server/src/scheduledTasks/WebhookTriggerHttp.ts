import {
  AutomationWebhookConflictError,
  AutomationWebhookInvalidRequestError,
  AutomationWebhookNotFoundError,
  AutomationWebhookPayloadTooLargeError,
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
  AutomationWebhookEvent,
  type AutomationWebhookTriggerRequest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
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
import * as ServerSettings from "../serverSettings.ts";
import * as AutomationEventLog from "./AutomationEventLog.ts";
import { ScheduledTaskService, withEventBlock } from "./ScheduledTaskService.ts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

const encodeEventJson = Schema.encodeUnknownEffect(fromJsonStringPretty(AutomationWebhookEvent));

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

/**
 * HTTP status for a recorded rejection, derived from the error tag so the
 * delivery log's `http_status` always matches what the client saw.
 */
function httpStatusForError(error: { readonly _tag: string }): number {
  switch (error._tag) {
    case "AutomationWebhookNotFoundError":
      return 404;
    case "AutomationWebhookConflictError":
      return 409;
    case "AutomationWebhookInvalidRequestError":
      return 422;
    case "AutomationWebhookPayloadTooLargeError":
      return 413;
    default:
      return 500;
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
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const events = yield* AutomationEventLog.AutomationEventLog;

    return handlers.handle(
      "trigger",
      Effect.fn("environment.automations.trigger")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        const principal = yield* requireEnvironmentScope("automation:trigger");
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.catch(() => failEnvironmentInternal("internal_error")),
        );
        // Disabled answers 404 like an unknown route: the machine has not
        // opted in to machine-to-machine automation, and its existence is not
        // advertised. Disabled deliveries are not logged — the endpoint is
        // effectively not there.
        if (!settings.enableAutomationWebhook) {
          return yield* new AutomationWebhookNotFoundError({
            code: "not_found",
            message: "Automation webhook is not enabled on this machine.",
          });
        }
        const request = args.payload;
        const eventJson =
          request.event === undefined
            ? undefined
            : yield* encodeEventJson(request.event).pipe(
                Effect.catch(() => failEnvironmentInternal("internal_error")),
              );

        const requested = planAutomationWebhookRequest(request);
        const plan = requested.ok ? requested.plan : null;
        const deliveryBase = {
          ...(request.fireKey === undefined ? {} : { fireKey: request.fireKey }),
          ...(eventJson === undefined ? {} : { eventJson }),
          keySubject: principal.subject,
          keySessionId: principal.sessionId,
        };

        const dispatch = Effect.gen(function* () {
          if (!requested.ok) return yield* requested.error;

          // Saved-task mode.
          if (requested.plan.mode === "task") {
            const fired = yield* scheduledTasks
              .fireTask({
                taskId: requested.plan.taskId,
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
          const projectId = requested.plan.projectId;
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
                text: withEventBlock(requested.plan.prompt, request.event),
                attachments: [],
              },
              createdBy: "system",
              creationSource: "server",
            })
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
          return { threadId: ThreadId.make(launched.threadId) };
        });

        return yield* dispatch.pipe(
          // The delivery log is observability, not a gate: record both
          // outcomes best-effort and let the trigger response stand on its own.
          Effect.tap((result) =>
            events.record({
              outcome: "accepted",
              httpStatus: 202,
              ...(plan?.mode === "task"
                ? { mode: plan.mode, taskId: plan.taskId }
                : plan?.mode === "adhoc"
                  ? { mode: plan.mode, projectId: plan.projectId }
                  : {}),
              threadId: result.threadId,
              ...deliveryBase,
            }),
          ),
          Effect.tapError((error) =>
            events.record({
              outcome: "rejected",
              httpStatus: httpStatusForError(error),
              ...(plan?.mode === "task"
                ? { mode: plan.mode, taskId: plan.taskId }
                : plan?.mode === "adhoc"
                  ? { mode: plan.mode, projectId: plan.projectId }
                  : {}),
              errorCode: error._tag,
              errorMessage: error.message,
              ...deliveryBase,
            }),
          ),
        );
      }),
    );
  }),
);
