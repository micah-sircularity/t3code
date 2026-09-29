import { describe, expect, it } from "@effect/vitest";

import {
  nextWorkflowStatus,
  rewriteUntrackedDiff,
  routeLabel,
  verdictFromText,
  workIdFromPayload,
} from "./WorkflowRun.ts";

describe("rewriteUntrackedDiff", () => {
  it("points the patch at the repo path", () => {
    const raw = ["diff --git a/dev/null b/notes.md", "--- /dev/null", "+++ b/notes.md", ""].join(
      "\n",
    );
    expect(rewriteUntrackedDiff("notes.md", raw)).toContain("diff --git a/notes.md b/notes.md");
    expect(rewriteUntrackedDiff("notes.md", raw)).toContain("+++ b/notes.md");
  });
});

describe("workIdFromPayload", () => {
  it("reads a nested id", () => {
    expect(workIdFromPayload(JSON.stringify({ issue: { id: 42 } }), "issue.id")).toBe("42");
  });

  it("returns null when the path is missing", () => {
    expect(workIdFromPayload("{}", "pull_request.number")).toBeNull();
  });
});

describe("verdictFromText", () => {
  it("stops only when the last line is STOP", () => {
    expect(verdictFromText("Looked at it.\nVERIFIED")).toBe("verified");
    expect(verdictFromText("Not ready.\nSTOP")).toBe("stopped");
  });
});

describe("nextWorkflowStatus", () => {
  it("waits for a later event before the next agent", () => {
    expect(
      nextWorkflowStatus({ agentIndex: 0, agentCount: 2, advance: "wait", verdict: "verified" }),
    ).toBe("waiting");
  });

  it("delivers after the last agent verifies", () => {
    expect(
      nextWorkflowStatus({
        agentIndex: 1,
        agentCount: 2,
        advance: "continue",
        verdict: "verified",
      }),
    ).toBe("delivered");
  });
});

describe("routeLabel", () => {
  it("defaults to auto balance", () => {
    expect(routeLabel({ id: "a", name: "Review", prompt: "" })).toBe("Auto balance");
  });
});
