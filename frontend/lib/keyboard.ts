import { useRef, type KeyboardEvent } from "react";

/**
 * Enter that confirms an input-method candidate (pinyin and the like) instead of typing a line.
 * Safari ends the composition before this keydown, so it only shows up as keyCode 229 there.
 */
export function isImeEnter(event: globalThis.KeyboardEvent) {
  return event.isComposing || event.keyCode === 229;
}

/**
 * Enter submits on key-up, Shift+Enter keeps its default (a new line in a textarea). The key-down is only
 * claimed when no input method is composing, so picking a candidate with Enter never submits.
 */
export function useEnterSubmit(onSubmit: () => void) {
  const armed = useRef(false);
  return {
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.key !== "Enter") return;
      armed.current = false;
      if (event.defaultPrevented || event.shiftKey || isImeEnter(event.nativeEvent)) return;
      event.preventDefault();
      armed.current = true;
    },
    onKeyUp(event: KeyboardEvent<HTMLElement>) {
      if (event.key !== "Enter" || !armed.current) return;
      armed.current = false;
      onSubmit();
    },
  };
}
