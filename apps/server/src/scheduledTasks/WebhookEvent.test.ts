import { describe, expect, it } from "@effect/vitest";

import { webhookPrompt } from "./ScheduledTaskService.ts";
import { normalizeWebhookEvent, renderWebhookEvent, webhookFilterAccepts } from "./WebhookEvent.ts";

const githubPullRequest = (action: string) =>
  normalizeWebhookEvent({
    headers: { "x-github-event": "pull_request" },
    body: JSON.stringify({
      action,
      repository: { full_name: "acme/app" },
      sender: { login: "octo" },
      pull_request: {
        number: 7,
        title: "Add checkout",
        html_url: "https://github.com/acme/app/pull/7",
        draft: false,
        head: { ref: "feature/checkout", sha: "abc123" },
        base: { ref: "main" },
      },
    }),
    sourceHint: null,
  });

describe("normalizeWebhookEvent", () => {
  it("keys GitHub events by event and action, most specific first", () => {
    const event = githubPullRequest("opened");
    expect(event.source).toBe("github");
    expect(event.keys).toEqual(["pull_request.opened", "pull_request"]);
    const rendered = renderWebhookEvent(event);
    expect(rendered).toContain("Pull request: 7");
    expect(rendered).toContain("Head SHA: abc123");
    expect(rendered).toContain("URL: https://github.com/acme/app/pull/7");
  });

  it("qualifies deployment_status by state", () => {
    const event = normalizeWebhookEvent({
      headers: { "x-github-event": "deployment_status" },
      body: JSON.stringify({
        deployment_status: { state: "success", target_url: "https://preview.example" },
        deployment: { environment: "Preview", sha: "def456" },
      }),
      sourceHint: null,
    });
    expect(event.keys).toEqual(["deployment_status.success", "deployment_status"]);
    expect(renderWebhookEvent(event)).toContain("Target URL: https://preview.example");
  });

  it("recognizes Basecamp deliveries by kind and recording", () => {
    const event = normalizeWebhookEvent({
      headers: {},
      body: JSON.stringify({
        kind: "todo_created",
        recording: {
          id: 99,
          type: "Todo",
          title: "QA the booking flow",
          app_url: "https://3.basecamp.com/1/buckets/2/todos/99",
          bucket: { id: 2, name: "Chez" },
        },
        creator: { name: "Micah" },
      }),
      sourceHint: null,
    });
    expect(event.source).toBe("basecamp");
    expect(event.keys).toEqual(["todo_created"]);
    expect(renderWebhookEvent(event)).toContain("Title: QA the booking flow");
  });

  it("falls back to the source hint for other senders", () => {
    const event = normalizeWebhookEvent({ headers: {}, body: "hello", sourceHint: "slack" });
    expect(event.source).toBe("webhook");
    expect(event.keys).toEqual(["slack"]);
  });
});

describe("webhookFilterAccepts", () => {
  it("accepts everything when no filter is set", () => {
    expect(webhookFilterAccepts({ type: "webhook" }, githubPullRequest("labeled"))).toBe(true);
  });

  it("matches exact action keys and bare event names", () => {
    const opened = githubPullRequest("opened");
    const labeled = githubPullRequest("labeled");
    const schedule = {
      type: "webhook" as const,
      source: "github" as const,
      events: ["pull_request.opened", "pull_request.synchronize"],
    };
    expect(webhookFilterAccepts(schedule, opened)).toBe(true);
    expect(webhookFilterAccepts(schedule, labeled)).toBe(false);
    expect(webhookFilterAccepts({ type: "webhook", events: ["pull_request"] }, labeled)).toBe(true);
  });

  it("rejects deliveries from a different source", () => {
    expect(
      webhookFilterAccepts({ type: "webhook", source: "basecamp" }, githubPullRequest("opened")),
    ).toBe(false);
  });
});

describe("webhookPrompt", () => {
  it("wraps the rendered event after the task prompt", () => {
    const event = githubPullRequest("opened");
    const prompt = webhookPrompt(
      "Review this PR.",
      "test:1",
      event.keys[0]!,
      renderWebhookEvent(event),
    );
    expect(
      prompt.startsWith(
        'Review this PR.\n\n<webhook_event source="pull_request.opened" delivery="test:1">',
      ),
    ).toBe(true);
    expect(prompt).toContain("Title: Add checkout");
    expect(prompt.endsWith("</webhook_event>")).toBe(true);
  });

  it("previews a skipped sample without matching", () => {
    const event = githubPullRequest("labeled");
    expect(webhookFilterAccepts({ type: "webhook", events: ["pull_request.opened"] }, event)).toBe(
      false,
    );
    expect(event.keys[0]).toBe("pull_request.labeled");
  });
});
