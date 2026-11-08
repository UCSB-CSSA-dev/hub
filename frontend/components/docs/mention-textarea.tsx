"use client";

import { useLocale } from "next-intl";
import { useMemo, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import { PersonAvatar } from "@/components/people/person-avatar";
import type { UserSummaryLike } from "@/components/people/types";
import { matchesPerson } from "@/components/people/use-people";
import { Textarea } from "@/components/ui/textarea";
import { MENTION_PATTERN, mentionToken } from "@/lib/api";
import type { Locale } from "@/lib/locale-store";
import { displayName } from "@/lib/names";
import { isImeEnter } from "@/lib/keyboard";
import { cn } from "@/lib/utils";

type MentionMap = Map<string, string>;

function encode(text: string, mentions: MentionMap) {
  let result = text;
  const labels = [...mentions.keys()].sort((a, b) => b.length - a.length);
  for (const label of labels) result = result.split(`@${label}`).join(mentionToken(mentions.get(label)!));
  return result;
}

function decode(value: string, people: UserSummaryLike[], locale: Locale) {
  const mentions: MentionMap = new Map();
  const text = value.replace(MENTION_PATTERN, (token, id: string) => {
    const person = people.find((p) => p._id === id);
    if (!person) return token;
    const label = displayName(person, locale);
    mentions.set(label, id);
    return `@${label}`;
  });
  return { text, mentions };
}

/**
 * Plain textarea where "@" picks a member. Shows "@Name" while typing; `onChange` receives the
 * text with mention tokens. `people` are the candidates; `known` also resolves tokens already in
 * the initial value.
 */
export function MentionTextarea({
  defaultValue,
  onChange,
  people,
  known = [],
  ...props
}: Omit<ComponentProps<typeof Textarea>, "value" | "defaultValue" | "onChange"> & {
  defaultValue: string;
  onChange: (encoded: string) => void;
  people: UserSummaryLike[];
  known?: UserSummaryLike[];
}) {
  const locale = useLocale() as Locale;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [initial] = useState(() => decode(defaultValue, [...known, ...people], locale));
  const [text, setText] = useState(initial.text);
  const [mentions, setMentions] = useState<MentionMap>(initial.mentions);
  const [query, setQuery] = useState<string | null>(null);
  const [index, setIndex] = useState(0);

  const candidates = useMemo(
    () => (query === null ? [] : people.filter((p) => matchesPerson(p, query)).slice(0, 8)),
    [people, query],
  );

  const update = (next: string, map: MentionMap, caret: number) => {
    setText(next);
    onChange(encode(next, map));
    const match = /@([^\s@]{0,20})$/.exec(next.slice(0, caret));
    setQuery(match ? match[1] : null);
    setIndex(0);
  };

  const pick = (person: UserSummaryLike) => {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart;
    const before = text.slice(0, caret).replace(/@([^\s@]{0,20})$/, "");
    const label = displayName(person, locale);
    const next = `${before}@${label} ${text.slice(caret)}`;
    const map = new Map(mentions).set(label, person._id);
    setMentions(map);
    setText(next);
    onChange(encode(next, map));
    setQuery(null);
    requestAnimationFrame(() => {
      const position = before.length + label.length + 2;
      el.focus();
      el.setSelectionRange(position, position);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (query === null || candidates.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setIndex((i) => (i + delta + candidates.length) % candidates.length);
    } else if ((event.key === "Enter" || event.key === "Tab") && !isImeEnter(event.nativeEvent)) {
      event.preventDefault();
      pick(candidates[index]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setQuery(null);
    }
  };

  return (
    <div className="relative">
      <Textarea
        {...props}
        ref={ref}
        value={text}
        onChange={(e) => update(e.target.value, mentions, e.target.selectionStart)}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
      />
      {query !== null && candidates.length > 0 ? (
        <div className="absolute top-full left-0 z-20 mt-1 w-72 overflow-hidden rounded-md border border-border bg-popover p-1 shadow-md">
          {candidates.map((person, i) => (
            <button
              key={person._id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                pick(person);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm",
                i === index ? "bg-accent" : "hover:bg-accent",
              )}
            >
              <PersonAvatar person={person} className="size-6" />
              <span className="truncate">{displayName(person, locale)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Rewrites mention tokens into links the markdown view renders as chips. */
export function linkMentions(source: string, people: UserSummaryLike[], locale: Locale) {
  return source.replace(MENTION_PATTERN, (token, id: string) => {
    const person = people.find((p) => p._id === id);
    return person ? `[@${displayName(person, locale).replace(/[[\]]/g, "")}](mention:${id})` : token;
  });
}
