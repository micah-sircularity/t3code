import type { ProviderDriverKind, ServerProviderSkill } from "@t3tools/contracts";
import { formatProviderSkillDisplayName } from "@t3tools/client-runtime/providerSkills";
import { useCallback, useMemo, useRef, useState } from "react";

import { detectComposerTrigger } from "../../composer-logic";
import { useTheme } from "../../hooks/useTheme";
import { searchProviderSkills } from "../../providerSkillSearch";
import { type ComposerCommandItem, ComposerCommandMenu } from "../chat/ComposerCommandMenu";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";
import { type ComposerPromptEditorHandle, ComposerPromptEditor } from "../ComposerPromptEditor";

/**
 * Automation prompt field with the composer's `$skill` picker and chips. Skills
 * come from the provider snapshot of the machine the task runs on.
 */
export function ScheduledTaskPromptEditor(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly provider: ProviderDriverKind;
  readonly disabled: boolean;
  readonly placeholder: string;
}) {
  const { value, onChange, skills, provider } = props;
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const { resolvedTheme } = useTheme();
  const [cursor, setCursor] = useState(value.length);
  const [expandedCursor, setExpandedCursor] = useState(value.length);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  const trigger = useMemo(() => {
    const detected = detectComposerTrigger(value, expandedCursor);
    if (detected?.kind !== "skill" || detected.rangeStart === dismissedAt) return null;
    return detected;
  }, [value, expandedCursor, dismissedAt]);

  const items = useMemo<ComposerCommandItem[]>(
    () =>
      trigger === null
        ? []
        : searchProviderSkills(skills, trigger.query).map((skill) => ({
            id: `skill:${provider}:${skill.name}`,
            type: "skill" as const,
            provider,
            skill,
            label: formatProviderSkillDisplayName(skill),
            description:
              skill.shortDescription ??
              skill.description ??
              (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
          })),
    [trigger, skills, provider],
  );
  const activeId = items.some((item) => item.id === highlightedId)
    ? highlightedId
    : (items[0]?.id ?? null);

  const select = useCallback(
    (item: ComposerCommandItem) => {
      if (item.type !== "skill" || trigger === null) return;
      const replacement = `$${item.skill.name} `;
      const end = value[trigger.rangeEnd] === " " ? trigger.rangeEnd + 1 : trigger.rangeEnd;
      const next = value.slice(0, trigger.rangeStart) + replacement + value.slice(end);
      const nextCursor = trigger.rangeStart + replacement.length;
      onChange(next);
      setCursor(nextCursor);
      setExpandedCursor(nextCursor);
      setHighlightedId(null);
      window.requestAnimationFrame(() => editorRef.current?.focusAt(nextCursor));
    },
    [onChange, trigger, value],
  );

  const onCommandKeyDown = useCallback(
    (key: string) => {
      if (trigger === null) return false;
      if (key === "Escape") {
        setDismissedAt(trigger.rangeStart);
        return true;
      }
      if (items.length === 0) return false;
      const index = Math.max(
        0,
        items.findIndex((item) => item.id === activeId),
      );
      if (key === "ArrowDown" || key === "ArrowUp") {
        const step = key === "ArrowDown" ? 1 : -1;
        setHighlightedId(items[(index + step + items.length) % items.length]!.id);
        return true;
      }
      if (key === "Enter" || key === "Tab") {
        select(items[index]!);
        return true;
      }
      return false;
    },
    [activeId, items, select, trigger],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="max-h-64 min-h-24 overflow-y-auto rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-xs/5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24">
        <ComposerPromptEditor
          editorRef={editorRef}
          value={value}
          cursor={cursor}
          contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
          skills={skills}
          disabled={props.disabled}
          placeholder={props.placeholder}
          onChange={(nextValue, nextCursor, nextExpandedCursor) => {
            onChange(nextValue);
            setCursor(nextCursor);
            setExpandedCursor(nextExpandedCursor);
            if (dismissedAt !== null && nextValue[dismissedAt] !== "$") setDismissedAt(null);
          }}
          onCommandKeyDown={onCommandKeyDown}
          onPaste={() => {}}
        />
      </div>
      {trigger !== null ? (
        <ComposerCommandMenu
          items={items}
          resolvedTheme={resolvedTheme}
          isLoading={false}
          triggerKind="skill"
          emptyStateText={
            skills.length === 0 ? "This machine's provider reports no skills." : "No skills match."
          }
          activeItemId={activeId}
          onHighlightedItemChange={setHighlightedId}
          onSelect={select}
        />
      ) : null}
    </div>
  );
}
