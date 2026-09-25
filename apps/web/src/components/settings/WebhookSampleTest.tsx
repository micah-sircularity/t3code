import type {
  EnvironmentId,
  ScheduledTaskId,
  ScheduledTaskSchedule,
  ScheduledTaskTestWebhookResult,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

interface SamplePreset {
  readonly id: string;
  readonly label: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

const REPO = { full_name: "acme/shop", html_url: "https://github.com/acme/shop" };
const SENDER = { login: "octocat" };

const SAMPLE_PRESETS: ReadonlyArray<SamplePreset> = [
  {
    id: "pr-opened",
    label: "PR opened",
    headers: { "x-github-event": "pull_request" },
    body: {
      action: "opened",
      number: 42,
      pull_request: {
        number: 42,
        title: "Add checkout flow",
        html_url: "https://github.com/acme/shop/pull/42",
        head: { ref: "feature/checkout", sha: "abc1234" },
        base: { ref: "main" },
        user: SENDER,
      },
      repository: REPO,
      sender: SENDER,
    },
  },
  {
    id: "pr-synchronize",
    label: "PR synchronize",
    headers: { "x-github-event": "pull_request" },
    body: {
      action: "synchronize",
      number: 42,
      pull_request: {
        number: 42,
        title: "Add checkout flow",
        html_url: "https://github.com/acme/shop/pull/42",
        head: { ref: "feature/checkout", sha: "def5678" },
        base: { ref: "main" },
        user: SENDER,
      },
      repository: REPO,
      sender: SENDER,
    },
  },
  {
    id: "deployment-success",
    label: "Deployment success",
    headers: { "x-github-event": "deployment_status" },
    body: {
      deployment_status: {
        state: "success",
        environment: "Preview",
        target_url: "https://shop-git-feature-checkout.vercel.app",
      },
      deployment: { ref: "feature/checkout", sha: "def5678", environment: "Preview" },
      repository: REPO,
      sender: SENDER,
    },
  },
  {
    id: "basecamp-todo",
    label: "Basecamp to-do created",
    headers: {},
    body: {
      kind: "todo_created",
      recording: {
        title: "Fix the checkout button on mobile",
        app_url: "https://3.basecamp.com/1/buckets/2/todos/3",
        bucket: { name: "Shop" },
      },
      creator: { name: "Kyr" },
    },
  },
];

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function jsonError(text: string, allowEmpty: boolean): string | null {
  if (allowEmpty && text.trim() === "") return null;
  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid JSON";
  }
}

function parseHeaders(text: string): Record<string, string> {
  if (text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, String(value)] as const),
  );
}

/** Paste an example delivery, preview the match and prompt, and optionally run the saved task. */
export function WebhookSampleTest(props: {
  readonly environmentId: EnvironmentId;
  readonly taskId: ScheduledTaskId | null;
  readonly schedule: ScheduledTaskSchedule;
  readonly prompt: string;
  readonly headers: string;
  readonly body: string;
  readonly disabled: boolean;
  readonly onChange: (sample: { headers: string; body: string }) => void;
}) {
  const [pending, setPending] = useState<"test" | "run" | null>(null);
  const [result, setResult] = useState<ScheduledTaskTestWebhookResult | null>(null);
  const test = useAtomCommand(serverEnvironment.testScheduledWebhook, {
    label: "scheduled task webhook test",
  });
  const bodyError = props.body.trim() === "" ? null : jsonError(props.body, false);
  const headersError = jsonError(props.headers, true);
  const canTest =
    !props.disabled && pending === null && props.body.trim() !== "" && headersError === null;

  const submit = async (run: boolean) => {
    if (!canTest) return;
    setPending(run ? "run" : "test");
    const response = await test({
      environmentId: props.environmentId,
      input: {
        schedule: props.schedule,
        prompt: props.prompt.trim() || "(no prompt yet)",
        sample: { headers: parseHeaders(props.headers), body: props.body },
        ...(props.taskId ? { taskId: props.taskId } : {}),
        ...(run ? { run: true } : {}),
      },
    });
    setPending(null);
    if (response._tag === "Success") {
      setResult(response.value);
      if (run && response.value.run) {
        toastManager.add({ type: "success", title: "Run started with sample" });
      } else if (run) {
        toastManager.add({ type: "info", title: "Sample was skipped by the filter" });
      }
      return;
    }
    if (!isAtomCommandInterrupted(response)) {
      toastManager.add({
        type: "error",
        title: run ? "Could not run with sample" : "Could not test sample",
        description: String(squashAtomCommandFailure(response)),
      });
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="scheduled-task-webhook-sample">Sample payload</Label>
        <div className="flex flex-wrap justify-end gap-1">
          {SAMPLE_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              type="button"
              size="xs"
              variant="outline"
              disabled={props.disabled}
              onClick={() => {
                setResult(null);
                props.onChange({
                  headers: Object.keys(preset.headers).length > 0 ? prettyJson(preset.headers) : "",
                  body: prettyJson(preset.body),
                });
              }}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      </div>
      <Textarea
        id="scheduled-task-webhook-sample-headers"
        size="sm"
        className="font-mono text-xs"
        placeholder='Headers (optional), e.g. {"x-github-event": "pull_request"}'
        value={props.headers}
        disabled={props.disabled}
        onChange={(event) => {
          setResult(null);
          props.onChange({ headers: event.target.value, body: props.body });
        }}
      />
      {headersError ? <p className="text-xs text-destructive">Headers: {headersError}</p> : null}
      <Textarea
        id="scheduled-task-webhook-sample"
        size="sm"
        className="font-mono text-xs"
        placeholder="Paste a JSON body from the sender's delivery log, or pick a preset."
        value={props.body}
        disabled={props.disabled}
        onChange={(event) => {
          setResult(null);
          props.onChange({ headers: props.headers, body: event.target.value });
        }}
      />
      {bodyError ? (
        <p className="text-xs text-destructive">
          Not valid JSON ({bodyError}). It is still sent as raw text.
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canTest}
          onClick={() => void submit(false)}
        >
          {pending === "test" ? "Testing…" : "Test"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canTest || props.taskId === null}
          title={props.taskId === null ? "Save the task first" : undefined}
          onClick={() => void submit(true)}
        >
          {pending === "run" ? "Starting…" : "Run with sample"}
        </Button>
      </div>
      {result ? (
        <div className="flex flex-col gap-2" role="status">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant={result.accepted ? "success" : "outline"}>
              {result.accepted ? "Would run" : "Skipped"}
            </Badge>
            <span className="text-muted-foreground">
              Detected {result.source}
              {result.keys.length > 0 ? ` · ${result.keys.join(", ")}` : ""}
            </span>
          </div>
          <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
            {result.renderedPrompt}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
