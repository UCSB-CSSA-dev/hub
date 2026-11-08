"use client";

import { useSyncExternalStore } from "react";

import { FONT_SCALE, FONT_SIZE_STORAGE_KEY as STORAGE_KEY, FONT_SIZES, type FontSize } from "./font-size";

const CHANGE_EVENT = "cssa-hub-font-size-change";

function parse(value: string | null): FontSize {
  return FONT_SIZES.includes(value as FontSize) ? (value as FontSize) : "default";
}

function read(): FontSize {
  const current = document.documentElement.style.fontSize;
  return FONT_SIZES.find((size) => FONT_SCALE[size] === current) ?? "default";
}

function applyFontSize(size: FontSize) {
  document.documentElement.style.fontSize = FONT_SCALE[size];
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function setStoredFontSize(size: FontSize) {
  applyFontSize(size);
  try {
    if (size === "default") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, size);
  } catch { /* Keep the setting usable when storage is unavailable. */ }
}

function subscribe(callback: () => void) {
  const sync = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) applyFontSize(parse(event.newValue));
  };
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", sync);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", sync);
  };
}

export function useStoredFontSize(): FontSize {
  return useSyncExternalStore(subscribe, read, () => "default");
}
