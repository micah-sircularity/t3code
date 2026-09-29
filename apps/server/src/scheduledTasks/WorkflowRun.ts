import type { WorkflowAgent, WorkflowRunStatus } from "@t3tools/contracts";

/** Read a dot path such as "pull_request.number" or "issue.id" from a JSON body. */
export function workIdFromPayload(body: string, workKey: string | undefined): string | null {
  if (workKey === undefined || workKey.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  let current: unknown = parsed;
  for (const key of workKey.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current === "string" && current.length > 0) return current;
  if (typeof current === "number" && Number.isFinite(current)) return String(current);
  return null;
}

export function routeLabel(agent: WorkflowAgent): string {
  const route = agent.route ?? { type: "auto" as const };
  if (route.type === "auto") return "Auto balance";
  return route.label ?? route.environmentId;
}

/** The agent's last line decides the loop. STOP ends it. Anything else continues. */
export function verdictFromText(text: string): "verified" | "stopped" {
  const line = text.trim().split("\n").at(-1)?.trim().toUpperCase() ?? "";
  return line === "STOP" ? "stopped" : "verified";
}

export function nextWorkflowStatus(input: {
  readonly agentIndex: number;
  readonly agentCount: number;
  readonly advance: "continue" | "wait";
  readonly verdict: "verified" | "stopped";
}): WorkflowRunStatus {
  if (input.verdict === "stopped") return "stopped";
  if (input.agentIndex >= input.agentCount - 1) return "delivered";
  return input.advance === "wait" ? "waiting" : "verified";
}
