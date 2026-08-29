import { createFileRoute } from "@tanstack/react-router";

import { AutomationWebhookSettings } from "../components/settings/AutomationWebhookSettings";

export const Route = createFileRoute("/settings/automation-webhook")({
  component: AutomationWebhookSettings,
});
