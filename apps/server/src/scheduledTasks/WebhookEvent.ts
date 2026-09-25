import type { ScheduledTaskSchedule } from "@t3tools/contracts";

const RAW_PAYLOAD_MAX_CHARS = 20_000;

export interface WebhookDelivery {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  readonly sourceHint: string | null;
}

export interface NormalizedWebhookEvent {
  readonly source: "github" | "basecamp" | "webhook";
  /** Most specific first, e.g. ["pull_request.opened", "pull_request"]. */
  readonly keys: ReadonlyArray<string>;
  readonly summary: ReadonlyArray<string>;
  readonly raw: string;
}

type Json = Record<string, unknown>;

const record = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0
    ? value
    : typeof value === "number"
      ? String(value)
      : null;
const at = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((current, key) => record(current)?.[key], value);

function line(label: string, value: unknown): string[] {
  const rendered = text(value);
  return rendered === null ? [] : [`${label}: ${rendered}`];
}

function githubSummary(event: string, payload: Json): string[] {
  const pr = record(payload.pull_request) ?? record(at(payload, "issue", "pull_request"));
  const issue = record(payload.issue);
  const subject = pr ?? issue;
  return [
    ...line("Repository", at(payload, "repository", "full_name")),
    ...line("Sender", at(payload, "sender", "login")),
    ...(subject
      ? [
          ...line(pr ? "Pull request" : "Issue", subject.number ?? issue?.number),
          ...line("Title", subject.title ?? issue?.title),
          ...line("URL", subject.html_url ?? issue?.html_url),
          ...line("Head branch", at(payload, "pull_request", "head", "ref")),
          ...line("Head SHA", at(payload, "pull_request", "head", "sha")),
          ...line("Base branch", at(payload, "pull_request", "base", "ref")),
          ...line("Draft", at(payload, "pull_request", "draft")),
        ]
      : []),
    ...line("Comment", at(payload, "comment", "body")),
    ...line("Review state", at(payload, "review", "state")),
    ...(event === "deployment_status"
      ? [
          ...line("Deployment state", at(payload, "deployment_status", "state")),
          ...line("Environment", at(payload, "deployment", "environment")),
          ...line("Target URL", at(payload, "deployment_status", "target_url")),
          ...line("Environment URL", at(payload, "deployment_status", "environment_url")),
          ...line("SHA", at(payload, "deployment", "sha")),
        ]
      : []),
    ...(event === "workflow_run"
      ? [
          ...line("Workflow", at(payload, "workflow_run", "name")),
          ...line("Conclusion", at(payload, "workflow_run", "conclusion")),
          ...line("Run URL", at(payload, "workflow_run", "html_url")),
        ]
      : []),
    ...(event === "push" ? [...line("Ref", payload.ref), ...line("After", payload.after)] : []),
  ];
}

function basecampSummary(payload: Json): string[] {
  const recording = record(payload.recording);
  return [
    ...line("Kind", payload.kind),
    ...line("Project", at(recording, "bucket", "name")),
    ...line("Project id", at(recording, "bucket", "id")),
    ...line("Recording type", recording?.type),
    ...line("Recording id", recording?.id),
    ...line("Title", recording?.title),
    ...line("URL", recording?.app_url),
    ...line("Parent", at(recording, "parent", "title")),
    ...line("Creator", at(payload, "creator", "name")),
  ];
}

export function normalizeWebhookEvent(delivery: WebhookDelivery): NormalizedWebhookEvent {
  let payload: Json | null = null;
  try {
    payload = record(JSON.parse(delivery.body));
  } catch {
    payload = null;
  }
  const raw =
    delivery.body.length > RAW_PAYLOAD_MAX_CHARS
      ? `${delivery.body.slice(0, RAW_PAYLOAD_MAX_CHARS)}\n…[truncated ${delivery.body.length - RAW_PAYLOAD_MAX_CHARS} chars]`
      : delivery.body;

  const githubEvent = delivery.headers["x-github-event"];
  if (githubEvent !== undefined) {
    const qualifier = text(payload?.action) ?? text(at(payload, "deployment_status", "state"));
    return {
      source: "github",
      keys: qualifier === null ? [githubEvent] : [`${githubEvent}.${qualifier}`, githubEvent],
      summary: [
        `Event: ${qualifier === null ? githubEvent : `${githubEvent}.${qualifier}`}`,
        ...(payload ? githubSummary(githubEvent, payload) : []),
      ],
      raw,
    };
  }

  const basecampKind = text(payload?.kind);
  if (basecampKind !== null && record(payload?.recording) !== null) {
    return {
      source: "basecamp",
      keys: [basecampKind],
      summary: payload ? basecampSummary(payload) : [],
      raw,
    };
  }

  const hint = delivery.sourceHint ?? "webhook";
  return { source: "webhook", keys: [hint], summary: [`Source: ${hint}`], raw };
}

/** True when the task's webhook filter accepts this event. */
export function webhookFilterAccepts(
  schedule: Extract<ScheduledTaskSchedule, { type: "webhook" }>,
  event: NormalizedWebhookEvent,
): boolean {
  const source = schedule.source ?? "any";
  if (source !== "any" && source !== event.source) return false;
  const events = schedule.events ?? [];
  return events.length === 0 || event.keys.some((key) => events.includes(key));
}

export function renderWebhookEvent(event: NormalizedWebhookEvent): string {
  return [...event.summary, "", "Raw payload:", event.raw].join("\n");
}
