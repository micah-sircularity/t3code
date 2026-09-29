import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId, WorkflowRunView } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import type { ModelEsque } from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import type { WorkflowAgentDraft } from "./scheduledTasksSettings.logic";

function routeText(agent: WorkflowAgentDraft): string {
  return agent.route === "auto" ? "Auto balance" : agent.routeLabel || "Pinned machine";
}

/** A route worth stating once. Auto balance is the default, so a shared auto route stays off the row. */
export function sharedStepRoute(agents: ReadonlyArray<WorkflowAgentDraft>): string | null {
  const first = agents[0];
  if (first === undefined) return null;
  const label = routeText(first);
  if (label === "Auto balance") return null;
  return agents.every((agent) => routeText(agent) === label) ? label : null;
}

function modelText(modelKey: string): string | null {
  const separator = modelKey.indexOf(":");
  if (separator <= 0 || separator === modelKey.length - 1) return null;
  return modelKey.slice(separator + 1);
}

function agentStatus(
  index: number,
  run: WorkflowRunView | null | undefined,
): "waiting" | "running" | "verified" | "stopped" | null {
  if (run === undefined || run === null) return null;
  if (index < run.agentIndex) return run.status === "stopped" ? "stopped" : "verified";
  if (index > run.agentIndex) return null;
  if (run.status === "delivered") return "verified";
  if (run.status === "verified") return "verified";
  if (run.status === "waiting") return "waiting";
  if (run.status === "stopped") return "stopped";
  return "running";
}

function statusLabel(status: ReturnType<typeof agentStatus>): string | null {
  if (status === "waiting") return "Waiting";
  if (status === "running") return "Running";
  if (status === "verified") return "Verified";
  if (status === "stopped") return "Stopped";
  return null;
}

/** Read-only row of the verification loop. Editing stays in the fields under the picture. */
export function VerificationPath(props: {
  readonly trigger: string;
  readonly agents: ReadonlyArray<WorkflowAgentDraft>;
  readonly delivery: string;
  readonly run?: WorkflowRunView | null | undefined;
}) {
  const showRoute =
    sharedStepRoute(props.agents) === null && props.agents.some((agent) => agent.route !== "auto");
  const nodes = [
    { key: "trigger", title: "Trigger", detail: props.trigger },
    ...props.agents.map((agent, index) => ({
      key: agent.id,
      title: agent.name || "Agent",
      detail: [
        modelText(agent.modelKey),
        showRoute ? routeText(agent) : null,
        statusLabel(agentStatus(index, props.run)),
      ]
        .filter((part) => part !== null && part !== "")
        .join(" · "),
    })),
    { key: "delivery", title: "Delivery", detail: props.delivery || "Record the result" },
  ];
  return (
    <ol
      className="flex w-full min-w-0 items-stretch overflow-x-auto"
      aria-label="Verification loop"
    >
      {nodes.map((node, index) => (
        <li key={node.key} className="flex min-w-0 items-stretch">
          {index > 0 ? (
            <ChevronRightIcon
              className="mx-1 size-3.5 shrink-0 self-center text-muted-foreground"
              aria-hidden
            />
          ) : null}
          <div className="flex h-full w-40 shrink-0 flex-col justify-center gap-0.5 rounded-md bg-muted/40 px-2.5 py-1.5">
            <p
              className="line-clamp-2 text-xs font-medium leading-snug text-foreground"
              title={node.title}
            >
              {node.title}
            </p>
            {node.detail ? (
              <p
                className="line-clamp-2 text-xs leading-snug text-muted-foreground"
                title={node.detail}
              >
                {node.detail}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function VerificationAgentFields(props: {
  readonly trigger: string;
  readonly agents: ReadonlyArray<WorkflowAgentDraft>;
  readonly workKey: string;
  readonly deliverySummary: string;
  readonly environments: ReadonlyArray<{ readonly id: EnvironmentId; readonly label: string }>;
  readonly fallbackEnvironmentId: EnvironmentId;
  readonly triggerClassName?: string;
  readonly disabled: boolean;
  readonly onChange: (next: {
    readonly agents: ReadonlyArray<WorkflowAgentDraft>;
    readonly workKey: string;
    readonly deliverySummary: string;
  }) => void;
}) {
  const update = (agents: ReadonlyArray<WorkflowAgentDraft>) =>
    props.onChange({ agents, workKey: props.workKey, deliverySummary: props.deliverySummary });
  return (
    <div className="flex flex-col gap-3">
      <VerificationPath
        trigger={props.trigger}
        agents={props.agents}
        delivery={props.deliverySummary}
      />
      <div className="flex flex-col gap-2">
        <Label htmlFor="verification-work-key">Same work</Label>
        <Input
          id="verification-work-key"
          nativeInput
          disabled={props.disabled}
          placeholder="issue.id or pull_request.number"
          value={props.workKey}
          onChange={(event) =>
            props.onChange({
              agents: props.agents,
              workKey: event.target.value,
              deliverySummary: props.deliverySummary,
            })
          }
        />
      </div>
      {props.agents.map((agent, index) => (
        <div key={agent.id} className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`verification-agent-${agent.id}`}>Agent {index + 1}</Label>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={props.disabled || props.agents.length === 1}
              onClick={() => update(props.agents.filter((entry) => entry.id !== agent.id))}
            >
              Remove
            </Button>
          </div>
          <Input
            id={`verification-agent-${agent.id}`}
            nativeInput
            disabled={props.disabled}
            value={agent.name}
            placeholder="Name"
            onChange={(event) =>
              update(
                props.agents.map((entry) =>
                  entry.id === agent.id ? { ...entry, name: event.target.value } : entry,
                ),
              )
            }
          />
          <div className="flex flex-col gap-1">
            <Label>Agent</Label>
            {agent.route === "auto" ? (
              <CommonProviderModelPicker
                environmentIds={
                  props.environments.length > 0
                    ? props.environments.map((environment) => environment.id)
                    : [props.fallbackEnvironmentId]
                }
                preferredEnvironmentId={props.fallbackEnvironmentId}
                modelKey={agent.modelKey}
                {...(props.triggerClassName === undefined
                  ? {}
                  : { triggerClassName: props.triggerClassName })}
                disabled={props.disabled}
                onChange={(modelKey) =>
                  update(
                    props.agents.map((entry) =>
                      entry.id === agent.id ? { ...entry, modelKey } : entry,
                    ),
                  )
                }
              />
            ) : (
              <MachineStepModelPicker
                environmentId={agent.route as EnvironmentId}
                modelKey={agent.modelKey}
                {...(props.triggerClassName === undefined
                  ? {}
                  : { triggerClassName: props.triggerClassName })}
                disabled={props.disabled}
                onChange={(modelKey) =>
                  update(
                    props.agents.map((entry) =>
                      entry.id === agent.id ? { ...entry, modelKey } : entry,
                    ),
                  )
                }
              />
            )}
          </div>
          <Textarea
            size="sm"
            disabled={props.disabled}
            value={agent.prompt}
            placeholder="What this agent checks. End with VERIFIED or STOP."
            onChange={(event) =>
              update(
                props.agents.map((entry) =>
                  entry.id === agent.id ? { ...entry, prompt: event.target.value } : entry,
                ),
              )
            }
          />
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Route
            <select
              className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
              disabled={props.disabled}
              value={agent.route}
              onChange={(event) => {
                const value = event.target.value;
                const environment = props.environments.find((entry) => entry.id === value);
                update(
                  props.agents.map((entry) =>
                    entry.id === agent.id
                      ? {
                          ...entry,
                          route: value,
                          routeLabel:
                            value === "auto" ? "Auto balance" : (environment?.label ?? value),
                        }
                      : entry,
                  ),
                );
              }}
            >
              <option value="auto">Auto balance</option>
              {props.environments.map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {environment.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Next agent
            <select
              className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
              disabled={props.disabled}
              value={agent.advance}
              onChange={(event) =>
                update(
                  props.agents.map((entry) =>
                    entry.id === agent.id
                      ? {
                          ...entry,
                          advance: event.target.value === "continue" ? "continue" : "wait",
                        }
                      : entry,
                  ),
                )
              }
            >
              <option value="wait">Wait for a later event</option>
              <option value="continue">Continue when this agent finishes</option>
            </select>
          </label>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={props.disabled}
        onClick={() =>
          update([
            ...props.agents,
            {
              id: `agent-${Date.now().toString(36)}-${props.agents.length}`,
              name: "Agent",
              prompt: "",
              modelKey: "",
              route: "auto",
              routeLabel: "Auto balance",
              advance: "wait",
            },
          ])
        }
      >
        Add agent
      </Button>
      <div className="flex flex-col gap-2">
        <Label htmlFor="verification-delivery">Delivery</Label>
        <Input
          id="verification-delivery"
          nativeInput
          disabled={props.disabled}
          placeholder="Record the result"
          value={props.deliverySummary}
          onChange={(event) =>
            props.onChange({
              agents: props.agents,
              workKey: props.workKey,
              deliverySummary: event.target.value,
            })
          }
        />
      </div>
    </div>
  );
}

function MachineStepModelPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly modelKey: string;
  readonly triggerClassName?: string;
  readonly disabled: boolean;
  readonly onChange: (modelKey: string) => void;
}) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const settings = useEnvironmentSettings(props.environmentId);
  const integrated = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ).filter(isProviderInstancePickerReady),
    [providers, settings],
  );
  const separator = props.modelKey.indexOf(":");
  const requestedInstanceId = (
    separator > 0 ? props.modelKey.slice(0, separator) : ""
  ) as ProviderInstanceId;
  const requestedModel = separator > 0 ? props.modelKey.slice(separator + 1) : "";
  const selected =
    integrated.find((entry) => entry.instanceId === requestedInstanceId) ?? integrated[0] ?? null;
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        settings,
        providers,
        selected?.instanceId,
        requestedModel || null,
      ),
    [providers, requestedModel, selected?.instanceId, settings],
  );
  const models = selected === null ? [] : (modelOptionsByInstance.get(selected.instanceId) ?? []);
  const modelIsIntegrated = models.some((entry) => entry.slug === requestedModel);
  const model = modelIsIntegrated ? requestedModel : (models[0]?.slug ?? "");
  useEffect(() => {
    if (selected === null || model === "") return;
    const nextKey = `${selected.instanceId}:${model}`;
    if (nextKey !== props.modelKey) props.onChange(nextKey);
  }, [model, props, selected]);
  if (selected === null) {
    return (
      <p className="text-xs text-muted-foreground">No provider is integrated on this machine.</p>
    );
  }
  return (
    <ProviderModelPicker
      disabled={props.disabled}
      activeInstanceId={selected.instanceId}
      model={model}
      lockedProvider={null}
      instanceEntries={integrated}
      modelOptionsByInstance={modelOptionsByInstance}
      isComposerOwned={false}
      {...(props.triggerClassName === undefined
        ? {}
        : { triggerClassName: props.triggerClassName })}
      onInstanceModelChange={(instanceId, nextModel) =>
        props.onChange(`${instanceId}:${nextModel}`)
      }
    />
  );
}

type ReadyCatalog = ReadonlyArray<{
  readonly driverKind: ProviderInstanceEntry["driverKind"];
  readonly instanceId: ProviderInstanceId;
  readonly slugs: ReadonlyArray<string>;
}>;

function commonModelKeys(catalogs: ReadonlyArray<ReadyCatalog>): ReadonlySet<string> {
  const [first, ...rest] = catalogs;
  if (first === undefined) return new Set();
  const keys = new Set<string>();
  for (const entry of first) {
    for (const slug of entry.slugs) {
      const key = `${entry.driverKind}\u0000${slug}`;
      const shared = rest.every((catalog) =>
        catalog.some(
          (other) => other.driverKind === entry.driverKind && other.slugs.includes(slug),
        ),
      );
      if (shared) keys.add(key);
    }
  }
  return keys;
}

function EnvironmentProviderCatalog(props: {
  readonly environmentId: EnvironmentId;
  readonly onCatalog: (
    environmentId: EnvironmentId,
    signature: string,
    catalog: ReadyCatalog,
  ) => void;
}) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const settings = useEnvironmentSettings(props.environmentId);
  const catalog = useMemo(() => {
    const integrated = sortProviderInstanceEntries(
      applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
    ).filter(isProviderInstancePickerReady);
    const options = getCustomModelOptionsByInstance(settings, providers);
    return integrated.map((entry) => ({
      driverKind: entry.driverKind,
      instanceId: entry.instanceId,
      slugs: (options.get(entry.instanceId) ?? []).map((model) => model.slug),
    }));
  }, [providers, settings]);
  const signature = JSON.stringify(catalog);
  useEffect(() => {
    props.onCatalog(props.environmentId, signature, catalog);
  }, [catalog, props, signature]);
  return null;
}

function CommonProviderModelPicker(props: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly preferredEnvironmentId: EnvironmentId;
  readonly modelKey: string;
  readonly triggerClassName?: string;
  readonly disabled: boolean;
  readonly onChange: (modelKey: string) => void;
}) {
  const [catalogs, setCatalogs] = useState<
    ReadonlyMap<string, { signature: string; catalog: ReadyCatalog }>
  >(new Map());
  const onCatalog = useCallback(
    (environmentId: EnvironmentId, signature: string, catalog: ReadyCatalog) => {
      setCatalogs((current) => {
        const previous = current.get(environmentId);
        if (previous?.signature === signature) return current;
        const next = new Map(current);
        next.set(environmentId, { signature, catalog });
        return next;
      });
    },
    [],
  );
  const ids =
    props.environmentIds.length > 0 ? props.environmentIds : [props.preferredEnvironmentId];
  const ready = ids.every((id) => catalogs.has(id));
  const commonKeys = useMemo(
    () => (ready ? commonModelKeys(ids.map((id) => catalogs.get(id)!.catalog)) : null),
    [catalogs, ids, ready],
  );
  return (
    <>
      {ids.map((environmentId) => (
        <EnvironmentProviderCatalog
          key={environmentId}
          environmentId={environmentId}
          onCatalog={onCatalog}
        />
      ))}
      {commonKeys === null ? null : (
        <PreferredCommonModelPicker
          environmentId={props.preferredEnvironmentId}
          commonKeys={commonKeys}
          modelKey={props.modelKey}
          {...(props.triggerClassName === undefined
            ? {}
            : { triggerClassName: props.triggerClassName })}
          disabled={props.disabled}
          onChange={props.onChange}
        />
      )}
    </>
  );
}

function PreferredCommonModelPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly commonKeys: ReadonlySet<string>;
  readonly modelKey: string;
  readonly triggerClassName?: string;
  readonly disabled: boolean;
  readonly onChange: (modelKey: string) => void;
}) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const settings = useEnvironmentSettings(props.environmentId);
  const modelOptionsByInstance = useMemo(() => {
    const options = getCustomModelOptionsByInstance(settings, providers);
    const filtered = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>();
    for (const [instanceId, models] of options) {
      const entry = deriveProviderInstanceEntries(providers).find(
        (candidate) => candidate.instanceId === instanceId,
      );
      if (entry === undefined) continue;
      const shared = models.filter((model) =>
        props.commonKeys.has(`${entry.driverKind}\u0000${model.slug}`),
      );
      if (shared.length > 0) filtered.set(instanceId, shared);
    }
    return filtered;
  }, [props.commonKeys, providers, settings]);
  const integrated = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      )
        .filter(isProviderInstancePickerReady)
        .filter((entry) => (modelOptionsByInstance.get(entry.instanceId)?.length ?? 0) > 0),
    [modelOptionsByInstance, providers, settings],
  );
  const separator = props.modelKey.indexOf(":");
  const requestedInstanceId = (
    separator > 0 ? props.modelKey.slice(0, separator) : ""
  ) as ProviderInstanceId;
  const requestedModel = separator > 0 ? props.modelKey.slice(separator + 1) : "";
  const selected =
    integrated.find(
      (entry) =>
        entry.instanceId === requestedInstanceId &&
        (modelOptionsByInstance.get(entry.instanceId) ?? []).some(
          (model) => model.slug === requestedModel,
        ),
    ) ??
    integrated.find((entry) =>
      (modelOptionsByInstance.get(entry.instanceId) ?? []).some(
        (model) => model.slug === requestedModel,
      ),
    ) ??
    integrated[0] ??
    null;
  const models = selected === null ? [] : (modelOptionsByInstance.get(selected.instanceId) ?? []);
  const model = models.some((entry) => entry.slug === requestedModel)
    ? requestedModel
    : (models[0]?.slug ?? "");
  useEffect(() => {
    if (selected === null || model === "") return;
    const nextKey = `${selected.instanceId}:${model}`;
    if (nextKey !== props.modelKey) props.onChange(nextKey);
  }, [model, props, selected]);
  if (selected === null) {
    return (
      <p className="text-xs text-muted-foreground">No provider is integrated on every machine.</p>
    );
  }
  return (
    <ProviderModelPicker
      disabled={props.disabled}
      activeInstanceId={selected.instanceId}
      model={model}
      lockedProvider={null}
      instanceEntries={integrated}
      modelOptionsByInstance={modelOptionsByInstance}
      isComposerOwned={false}
      {...(props.triggerClassName === undefined
        ? {}
        : { triggerClassName: props.triggerClassName })}
      onInstanceModelChange={(instanceId, nextModel) =>
        props.onChange(`${instanceId}:${nextModel}`)
      }
    />
  );
}
