"use client";

import type { MentionNodeAttrs } from "@tiptap/extension-mention";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionKeyDownProps, SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import { useImperativeHandle, useState, type Ref } from "react";
import { PersonAvatar } from "@/components/people/person-avatar";
import { matchesPerson } from "@/components/people/use-people";
import type { UserSummaryLike } from "@/components/people/types";
import type { Locale } from "@/lib/locale-store";
import { displayName } from "@/lib/names";
import { isImeEnter } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import type { MentionItem } from "./extensions";

type ListProps = SuggestionProps<MentionItem, MentionNodeAttrs>;
type ListHandle = { onKeyDown: (event: KeyboardEvent) => boolean };

function MentionList({ ref, ...props }: ListProps & { ref?: Ref<ListHandle> }) {
  const [selection, setSelection] = useState({ query: props.query, index: 0 });
  const index = selection.query === props.query ? Math.min(selection.index, props.items.length - 1) : 0;
  const pick = (item: MentionItem | undefined) => {
    if (item) props.command({ id: item.id, label: item.label });
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (props.items.length === 0) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setSelection({ query: props.query, index: (index + delta + props.items.length) % props.items.length });
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !isImeEnter(event)) {
        pick(props.items[index]);
        return true;
      }
      return false;
    },
  }));

  if (props.items.length === 0) return null;
  return (
    <div className="z-50 w-64 overflow-hidden rounded-md border border-border bg-popover p-1 shadow-md">
      {props.items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            pick(item);
          }}
          className={cn(
            "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm",
            i === index ? "bg-accent" : "hover:bg-accent",
          )}
        >
          <PersonAvatar person={item.person} className="size-6" />
          <span className="truncate">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/** A mutable list the suggestion popup reads from, kept outside React state. */
export class PeopleSource {
  constructor(private people: UserSummaryLike[]) {}
  get() {
    return this.people;
  }
  set(people: UserSummaryLike[]) {
    this.people = people;
  }
}

/**
 * "@" suggestions for the editor. `people` is read on every keystroke, so the list can change
 * without rebuilding the editor.
 */
export function mentionSuggestion(
  people: () => UserSummaryLike[],
  locale: Locale,
): Omit<SuggestionOptions<MentionItem, MentionNodeAttrs>, "editor"> {
  return {
    char: "@",
    // Chinese has no spaces, so "请@张三" must work too.
    allowedPrefixes: null,
    items: ({ query }) =>
      people()
        .filter((p) => matchesPerson(p, query))
        .slice(0, 8)
        .map((p) => ({ id: p._id, label: displayName(p, locale), person: p })),
    render: () => {
      let renderer: ReactRenderer<ListHandle, ListProps> | null = null;
      let unmount: (() => void) | undefined;
      return {
        onStart: (props) => {
          renderer = new ReactRenderer(MentionList, { props, editor: props.editor });
          unmount = props.mount(renderer.element as HTMLElement);
        },
        onUpdate: (props) => renderer?.updateProps(props),
        onKeyDown: ({ event }: SuggestionKeyDownProps) => {
          if (event.key === "Escape") return false;
          return renderer?.ref?.onKeyDown(event) ?? false;
        },
        onExit: () => {
          unmount?.();
          renderer?.destroy();
          renderer = null;
        },
      };
    },
  };
}
