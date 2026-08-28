# Automations

Schedule tasks are the one headless way work starts without a user message:
a stored task (project, prompt, model, workspace strategy, optional bound
thread) is dispatched into orchestration v2, which owns everything after
dispatch. This note covers how tasks are stored, what can trigger them, and
the seams that matter when adding a trigger kind.

## Storage and firing

- **Table**: `scheduled_tasks` (migration `051`). The schedule is stored as
  opaque `schedule_json`, so new trigger variants do not need a migration.
  Run history is columns (`last_run_at/status/error`, `run_count`), not a
  per-run table.
- **Firing is centralized** in `runTask(task, trigger, options)`
  (`apps/server/src/scheduledTasks/ScheduledTaskService.ts`). Every trigger
  source funnels into it, which gives all triggers the same guarantees:
  re-read before firing, single-run guard, run-state transitions, crash
  recovery, and deterministic idempotency keys.
- **Idempotency**: the `commandId` is derived from the task id plus a fire key
  (`scheduled-task:<taskId>:<fireKey>`). The v2 command-receipt store rejects
  or replays duplicate command ids, so webhook retries with the same
  `fireKey` cannot double-fire.
- **Dispatch**: `threadId === null` → `ThreadLaunchService.launch` (fresh
  thread, background worktree provisioning); otherwise
  `ThreadManagementService.sendToThread(mode: "auto")`. "Succeeded" in the
  run columns means _dispatch accepted_, not turn completed — completion is
  observable on the thread itself.

## Trigger kinds

The schedule union in `packages/contracts/src/scheduledTask.ts` is the
extension point. `nextRunAt` is both the firing mechanism for time-based
triggers and the UI's "next run" label; event-driven kinds keep it `null`,
which is what keeps the time-based poll loop away from them.

- **`interval` / `fixed_time`** — clock-driven. A single 5-second poll loop
  (`runDueTasks`) selects enabled tasks whose `next_run_at` has passed.
  Missed fixed-time runs beyond a grace window are skipped and re-aimed, not
  fired late.
- **`webhook`** — fires when `POST /api/automations/trigger` names the task
  (`WebhookTriggerHttp.ts`). The endpoint authenticates with a bearer session
  carrying the standalone `automation:trigger` scope, validates the request
  into a dispatch plan (`planAutomationWebhookRequest`), and either fires the
  saved task or launches an ad-hoc prompt in a named project. The webhook
  never touches the clock: `nextRunAt` stays null and `setEnabled` preserves
  that. See `docs/user/scheduled-tasks.md` for the operator-facing flow and
  key minting.

Planned: a GitHub event watcher that polls through the existing `gh` CLI
passthrough with conditional requests, feeding the same `runTask` seam with
per-task cursors — for repos where configuring a webhook is not an option.
