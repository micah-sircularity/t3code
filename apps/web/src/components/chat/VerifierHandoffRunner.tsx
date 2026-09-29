import { RegistryContext } from "@effect/atom-react";
import { chooseLoadBalancedEnvironment } from "@t3tools/client-runtime/load-balancing";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  MessageId,
  ThreadId,
  type EnvironmentId,
  type ScheduledTask,
  type VerifierHandoff,
} from "@t3tools/contracts";
import { useCallback, useContext, useEffect, useRef } from "react";

import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";

const WAIT_KEY = "t3.verifierWaits";

type VerifierWait = {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceThreadId: string;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetTaskId: string;
  readonly branch: string;
  readonly machine: string;
};

function readWaits(): VerifierWait[] {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(WAIT_KEY) ?? "[]") as VerifierWait[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeWaits(waits: readonly VerifierWait[]) {
  sessionStorage.setItem(WAIT_KEY, JSON.stringify(waits));
}

function EnvironmentVerifierWatch(props: {
  readonly environmentId: EnvironmentId;
  readonly onHandoffs: (environmentId: EnvironmentId, handoffs: readonly VerifierHandoff[]) => void;
  readonly onTasks: (environmentId: EnvironmentId, tasks: readonly ScheduledTask[]) => void;
}) {
  const handoffs = useEnvironmentQuery(
    serverEnvironment.verifierHandoffsLive({
      environmentId: props.environmentId,
      input: {},
    }),
  );
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({
      environmentId: props.environmentId,
      input: {},
    }),
  );
  useEffect(() => {
    if (handoffs.data) props.onHandoffs(props.environmentId, handoffs.data.handoffs);
  }, [handoffs.data, props.environmentId, props.onHandoffs]);
  useEffect(() => {
    if (tasks.data) props.onTasks(props.environmentId, tasks.data.tasks);
  }, [props.environmentId, props.onTasks, tasks.data]);
  return null;
}

export function VerifierHandoffRunner() {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const registry = useContext(RegistryContext);
  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const claim = useAtomCommand(serverEnvironment.claimVerifierHandoff, {
    label: "verifier handoff claim",
    reportFailure: false,
  });
  const prepare = useAtomCommand(serverEnvironment.prepareVerifierHandoff, {
    label: "verifier handoff prepare",
    reportFailure: false,
  });
  const settle = useAtomCommand(serverEnvironment.settleVerifierHandoff, {
    label: "verifier handoff settle",
    reportFailure: false,
  });
  const start = useAtomCommand(serverEnvironment.startVerifierRun, {
    label: "verifier run start",
    reportFailure: false,
  });
  const dispatch = useAtomCommand(serverEnvironment.dispatchOrchestrationCommand, {
    label: "verifier result",
    reportFailure: false,
  });
  const seen = useRef(new Set<string>());
  const waits = useRef<VerifierWait[]>(readWaits());
  const posted = useRef(new Set<string>());

  const fail = useCallback(
    async (environmentId: EnvironmentId, id: string, detail: string) => {
      await settle({ environmentId, input: { id, status: "failed", detail } });
    },
    [settle],
  );

  const send = useCallback(
    async (environmentId: EnvironmentId, handoff: VerifierHandoff) => {
      const claimed = await claim({ environmentId, input: { id: handoff.id } });
      if (claimed._tag !== "Success") {
        seen.current.delete(handoff.id);
        return;
      }
      if (!claimed.value.claimed) return;
      const source = projects.find(
        (project) => project.environmentId === environmentId && project.id === handoff.projectId,
      );
      const canonicalKey = source?.repositoryIdentity?.canonicalKey;
      const candidates = projects.filter(
        (project) =>
          project.environmentId !== environmentId &&
          connected.some((environment) => environment.environmentId === project.environmentId) &&
          canonicalKey !== undefined &&
          project.repositoryIdentity?.canonicalKey === canonicalKey,
      );
      if (canonicalKey === undefined || candidates.length === 0) {
        await fail(environmentId, handoff.id, "No other machine with this repo is connected.");
        return;
      }
      for (const project of candidates) {
        registry.refresh(
          serverEnvironment.hostResources({ environmentId: project.environmentId, input: {} }),
        );
      }
      const scored = candidates.map((project) => {
        const resources = registry.get(
          serverEnvironment.hostResources({ environmentId: project.environmentId, input: {} }),
        );
        return {
          environmentId: project.environmentId,
          resources: resources._tag === "Success" ? resources.value : null,
          receivedAt: resources._tag === "Success" ? resources.timestamp : 0,
          weight: 50,
        };
      });
      const chosen =
        (chooseLoadBalancedEnvironment(scored, Date.now()) as EnvironmentId | null) ??
        candidates[0]?.environmentId ??
        null;
      const targetProject = candidates.find((project) => project.environmentId === chosen);
      if (chosen === null || targetProject === undefined) {
        await fail(environmentId, handoff.id, "No other machine with this repo is connected.");
        return;
      }
      const prepared = await prepare({ environmentId, input: { id: handoff.id } });
      if (prepared._tag !== "Success") {
        await fail(environmentId, handoff.id, String(squashAtomCommandFailure(prepared)));
        return;
      }
      const machine =
        connected.find((environment) => environment.environmentId === chosen)?.label ?? chosen;
      const started = await start({
        environmentId: chosen,
        input: {
          projectId: targetProject.id,
          sourceTaskId: prepared.value.sourceTaskId,
          title: prepared.value.title,
          prompt: prepared.value.prompt,
          schedule: prepared.value.schedule,
          modelSelection: prepared.value.modelSelection,
          runtimeMode: prepared.value.runtimeMode,
          interactionMode: prepared.value.interactionMode,
          branch: prepared.value.branch,
          baseRef: prepared.value.baseRef,
          patch: prepared.value.patch,
          deliveryId: handoff.id,
        },
      });
      if (started._tag !== "Success") {
        await fail(environmentId, handoff.id, String(squashAtomCommandFailure(started)));
        return;
      }
      await settle({
        environmentId,
        input: { id: handoff.id, status: "running", targetLabel: machine },
      });
      const next = [
        ...waits.current.filter((wait) => wait.sourceThreadId !== handoff.threadId),
        {
          sourceEnvironmentId: environmentId,
          sourceThreadId: handoff.threadId,
          targetEnvironmentId: chosen,
          targetTaskId: `scheduled-task:verifier:${prepared.value.sourceTaskId}`,
          branch: prepared.value.branch,
          machine,
        },
      ];
      waits.current = next;
      writeWaits(next);
    },
    [claim, connected, fail, prepare, projects, registry, settle, start],
  );

  const onHandoffs = useCallback(
    (environmentId: EnvironmentId, handoffs: readonly VerifierHandoff[]) => {
      for (const handoff of handoffs) {
        if (handoff.status !== "pending" || seen.current.has(handoff.id)) continue;
        seen.current.add(handoff.id);
        void send(environmentId, handoff);
      }
    },
    [send],
  );

  const onTasks = useCallback(
    (environmentId: EnvironmentId, tasks: readonly ScheduledTask[]) => {
      const remaining: VerifierWait[] = [];
      for (const wait of waits.current) {
        if (wait.targetEnvironmentId !== environmentId) {
          remaining.push(wait);
          continue;
        }
        const task = tasks.find((candidate) => candidate.id === wait.targetTaskId);
        const run = task?.workflowRun;
        if (
          run === undefined ||
          run === null ||
          run.workId !== wait.branch ||
          (run.status !== "delivered" && run.status !== "stopped")
        ) {
          remaining.push(wait);
          continue;
        }
        const key = `${wait.sourceThreadId}:${wait.branch}:${run.status}`;
        if (posted.current.has(key)) continue;
        posted.current.add(key);
        const verdict = run.status === "stopped" ? "STOP" : "VERIFIED";
        void dispatch({
          environmentId: wait.sourceEnvironmentId,
          input: {
            type: "message.dispatch",
            commandId: CommandId.make(`verifier-result:${randomUUID()}`),
            createdBy: "system",
            creationSource: "web",
            threadId: ThreadId.make(wait.sourceThreadId),
            messageId: MessageId.make(randomUUID()),
            text: `Verifier on ${wait.machine} finished branch ${wait.branch}: ${verdict}.`,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          },
        });
      }
      if (remaining.length !== waits.current.length) {
        waits.current = remaining;
        writeWaits(remaining);
      }
    },
    [dispatch],
  );

  return connected.map((environment) => (
    <EnvironmentVerifierWatch
      key={environment.environmentId}
      environmentId={environment.environmentId}
      onHandoffs={onHandoffs}
      onTasks={onTasks}
    />
  ));
}
