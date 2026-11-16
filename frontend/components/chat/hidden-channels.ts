"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { Id } from "@/lib/api";

const KEY = "cssa-hub-hidden-channels";

function read(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const list = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function write(ids: Set<string>) {
  localStorage.setItem(KEY, JSON.stringify([...ids]));
  window.dispatchEvent(new Event("cssa-hub-hidden-channels"));
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener("cssa-hub-hidden-channels", onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener("cssa-hub-hidden-channels", onChange);
  };
}

/** Channels the viewer hid on this device only (groups and DMs). */
export function useHiddenChannels() {
  const hidden = useSyncExternalStore(subscribe, () => [...read()].sort().join(","), () => "");
  const set = new Set(hidden ? hidden.split(",") : []);

  const hide = useCallback((channelId: Id<"channels">) => {
    const next = read();
    next.add(channelId);
    write(next);
  }, []);

  const show = useCallback((channelId: Id<"channels">) => {
    const next = read();
    next.delete(channelId);
    write(next);
  }, []);

  const clear = useCallback(() => write(new Set()), []);

  return { hidden: set, hide, show, clear };
}
