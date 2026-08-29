import { CopyIcon, WebhookIcon } from "lucide-react";
import type { ScheduledTask } from "@t3tools/contracts";
import { useMemo } from "react";

import type { AutomationEventLogEntry } from "@t3tools/contracts";

import { formatRelativeTime } from "../../timestampFormat";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

const TRIGGER_PATH = "/api/automations/trigger";
const MINT_COMMAND = "t3 auth session issue --scope automation:trigger";

function CodeChip({ value }: { value: string }) {
  return (
    <code className="select-all rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-foreground">
      {value}
    </code>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<string>();
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={`Copy ${label}`}
      onClick={() => copyToClipboard(value, label)}
    >
      <CopyIcon className="size-3.5" />
      {isCopied ? <span className="sr-only">Copied</span> : null}
    </Button>
  );
}

function taskTitle(tasks: ReadonlyArray<ScheduledTask>, taskId: string): string {
  return tasks.find((task) => task.id === taskId)?.title ?? taskId;
}

export function AutomationWebhookSettings() {
  useRelativeTimeTick(15_000);
  const environment = usePrimaryEnvironment();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environment?.environmentId ?? null);

  const enabled = settings.enableAutomationWebhook;

  // Live task list: the caller puts one of these ids in the trigger payload.
  const tasksQuery = useEnvironmentQuery(
    environment
      ? serverEnvironment.scheduledTasksLive({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  // Live delivery log: every webhook request the machine received, accepted or not.
  const eventsQuery = useEnvironmentQuery(
    environment
      ? serverEnvironment.automationEventsLive({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );

  const tasks = tasksQuery.data?.tasks ?? [];
  const events = eventsQuery.data?.events ?? [];
  const endpointUrl = useMemo(
    () => (httpBaseUrl === null ? null : `${httpBaseUrl.replace(/\/$/, "")}${TRIGGER_PATH}`),
    [httpBaseUrl],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="Automation webhook" icon={<WebhookIcon className="size-3.5" />}>
        <div className="space-y-4 px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Enable automation webhook</p>
              <p className="max-w-xl text-xs text-muted-foreground">
                Let external systems fire schedule tasks or run prompts on this machine by POSTing
                to a single endpoint with an API key. Keys carry the standalone{" "}
                <CodeChip value="automation:trigger" /> scope — they can trigger automations and
                nothing else.
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={(checked) =>
                updateSettings({ enableAutomationWebhook: Boolean(checked) })
              }
              aria-label="Enable automation webhook"
            />
          </div>

          {enabled ? (
            <>
              <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">Endpoint</span>
                  {endpointUrl ? (
                    <CopyButton value={endpointUrl} label="webhook endpoint URL" />
                  ) : null}
                </div>
                {endpointUrl ? (
                  <CodeChip value={endpointUrl} />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Connect to this machine to see its endpoint URL.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Issue a key on this machine, then authenticate with{" "}
                  <CodeChip value="Authorization: Bearer <key>" />:
                </p>
                <div className="flex items-center justify-between gap-2">
                  <CodeChip value={MINT_COMMAND} />
                  <CopyButton value={MINT_COMMAND} label="API key mint command" />
                </div>
                <p className="text-xs text-muted-foreground">
                  Revoke keys any time in Settings → Connections.
                </p>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground">Triggerable tasks</p>
                {tasks.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No schedule tasks yet — create one under Schedule Tasks.
                  </p>
                ) : (
                  <div className="divide-y divide-border/60 rounded-lg border border-border/70">
                    {tasks.map((task) => (
                      <div
                        key={task.id}
                        className="flex items-center justify-between gap-3 px-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium text-foreground">
                            {task.title}
                          </p>
                          <div className="mt-0.5 flex items-center gap-1.5">
                            <CodeChip value={task.id} />
                            <CopyButton value={task.id} label={`task id for ${task.title}`} />
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Badge variant={task.enabled ? "success" : "outline"}>
                            {task.enabled ? "Enabled" : "Paused"}
                          </Badge>
                          <Badge variant={task.schedule.type === "webhook" ? "info" : "outline"}>
                            {task.schedule.type === "webhook" ? "Webhook" : "Scheduled"}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Fire one with <CodeChip value={'{"taskId": "<id>", "fireKey": "<unique>"}'} /> —
                  any enabled task works, whether it is scheduled or webhook-only.
                </p>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground">Recent deliveries</p>
                {events.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Nothing has called the webhook yet.
                  </p>
                ) : (
                  <div className="divide-y divide-border/60 rounded-lg border border-border/70">
                    {events.map((event) => (
                      <DeliveryRow key={event.id} event={event} tasks={tasks} />
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function DeliveryRow({
  event,
  tasks,
}: {
  readonly event: AutomationEventLogEntry;
  readonly tasks: ReadonlyArray<ScheduledTask>;
}) {
  const received = formatRelativeTime(event.receivedAt);
  const receivedLabel = received ? `${received.value} ${received.suffix ?? ""}`.trim() : "just now";
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate text-xs font-medium text-foreground">
          {event.mode === "task" && event.taskId !== null
            ? `Task: ${taskTitle(tasks, event.taskId)}`
            : "Ad-hoc prompt"}
        </p>
        <p className="truncate text-[11px] text-muted-foreground/80">
          {receivedLabel}
          {event.fireKey !== null ? ` · fireKey ${event.fireKey}` : ""}
          {event.threadId !== null ? ` · ${event.threadId}` : ""}
        </p>
        {event.errorMessage !== null ? (
          <p className="truncate text-[11px] text-destructive">{event.errorMessage}</p>
        ) : null}
      </div>
      <Badge variant={event.outcome === "accepted" ? "success" : "error"}>
        {event.outcome === "accepted" ? String(event.httpStatus) : `Rejected ${event.httpStatus}`}
      </Badge>
    </div>
  );
}
