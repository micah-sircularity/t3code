import type { ScheduledTaskWebhookSource } from "@t3tools/contracts";

import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const EVENT_PRESETS: Record<ScheduledTaskWebhookSource, ReadonlyArray<string>> = {
  any: [],
  github: [
    "pull_request.opened",
    "pull_request.synchronize",
    "pull_request.ready_for_review",
    "pull_request.closed",
    "pull_request_review.submitted",
    "issue_comment.created",
    "deployment_status.success",
    "workflow_run.completed",
    "push",
  ],
  basecamp: [
    "todo_created",
    "todo_completed",
    "comment_created",
    "message_created",
    "kanban_card_created",
    "kanban_card_moved",
  ],
};

function parseEvents(value: string): string[] {
  return value
    .split(/[\s,]+/u)
    .map((event) => event.trim())
    .filter((event) => event.length > 0);
}

/** Source and event filter for webhook-triggered automations. */
export function WebhookFilterFields(props: {
  readonly source: ScheduledTaskWebhookSource;
  readonly events: string;
  readonly disabled: boolean;
  readonly onSourceChange: (source: ScheduledTaskWebhookSource) => void;
  readonly onEventsChange: (events: string) => void;
}) {
  const selected = parseEvents(props.events);
  const presets = EVENT_PRESETS[props.source];
  const togglePreset = (event: string) => {
    const next = selected.includes(event)
      ? selected.filter((entry) => entry !== event)
      : [...selected, event];
    props.onEventsChange(next.join(", "));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Label>Source</Label>
        <ToggleGroup
          aria-label="Webhook source"
          variant="outline"
          size="sm"
          value={[props.source]}
          disabled={props.disabled}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "any" || next === "github" || next === "basecamp") {
              props.onSourceChange(next);
            }
          }}
        >
          <Toggle value="any">Any</Toggle>
          <Toggle value="github">GitHub</Toggle>
          <Toggle value="basecamp">Basecamp</Toggle>
        </ToggleGroup>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="scheduled-task-webhook-events">Events</Label>
        <Input
          id="scheduled-task-webhook-events"
          nativeInput
          disabled={props.disabled}
          placeholder="Every event"
          value={props.events}
          onChange={(event) => props.onEventsChange(event.target.value)}
        />
        {presets.length > 0 ? (
          <ToggleGroup
            multiple
            variant="outline"
            size="sm"
            aria-label="Common events"
            className="flex-wrap"
            value={selected.filter((event) => presets.includes(event))}
            disabled={props.disabled}
            onValueChange={(values) => {
              const changed =
                presets.find((event) => values.includes(event) !== selected.includes(event)) ??
                null;
              if (changed !== null) togglePreset(changed);
            }}
          >
            {presets.map((event) => (
              <Toggle key={event} value={event}>
                {event}
              </Toggle>
            ))}
          </ToggleGroup>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Other events get an accepted response but don&apos;t start a run. A bare event name such
          as <code>pull_request</code> matches every action. The agent receives a summary of the
          event plus the raw payload. Copy the URL from the task menu after saving.
        </p>
      </div>
    </div>
  );
}
