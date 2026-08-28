# Schedule tasks

Schedule tasks run a prompt automatically — on a clock, or when an external
event arrives. Each task belongs to a project, uses a chosen model, and starts
its own thread (or steers a thread you bind it to) every time it fires.

## Create a task

1. Open **Settings** and select **Schedule Tasks**.
2. Select **New**.
3. Fill in a name, the project to run in, the prompt, and the model to use.
4. Pick how the task runs:
   - **Daily** — runs at a fixed local time on the weekdays you pick.
   - **Interval** — runs repeatedly, every N minutes.
   - **Webhook** — runs only when something calls the automation webhook for
     this task. It never fires on a clock.
5. Save. Paused tasks never fire; **Run now** always works for a manual run.

Each run starts a fresh turn with your prompt. When the task fires from a
webhook event, the event's payload is included in the prompt so the agent can
read what happened.

## Trigger a task with a webhook

Webhook tasks wait for a request. To fire one, send an authenticated `POST` to
the environment's automation endpoint:

```
POST /api/automations/trigger
Authorization: Bearer <API key>
Content-Type: application/json

{
  "taskId": "scheduled-task:...",
  "event": { "repository": "acme/widgets", "action": "opened", "number": 42 },
  "fireKey": "github-delivery-guid"
}
```

- `taskId` fires one saved task. Its own prompt runs; `event` is optional
  context embedded into the prompt as JSON.
- `prompt` (with `projectId`) launches a fresh thread instead, using that
  project's model — for ad-hoc automations that don't need a saved task.
- `fireKey` makes the run idempotent. Retries with the same key (for example
  GitHub's delivery GUID) do not run the task twice.
- A paused task answers `409 Conflict`; an unknown task answers `404`.

## Issue an API key

The endpoint accepts a bearer session with the standalone
`automation:trigger` scope — a key that can fire automations and nothing else.
Mint one from the machine running the server:

```bash
t3 auth session issue --scope automation:trigger --label "GitHub webhooks"
```

Store the token somewhere safe: it is shown once and can be revoked any time
from **Settings → Connections**, alongside your other client sessions.

## Where the URL comes from

The endpoint lives on the same server as the rest of the app:

- On your LAN or tailnet, use the server's address directly.
- With T3 Connect linked, the managed tunnel hostname makes the endpoint
  publicly reachable, so services like GitHub webhooks can call it from the
  internet.
