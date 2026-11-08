import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { clearCache } from "@/lib/file-cache";

/** Per device: set once this browser has a push subscription saved for the signed-in user. */
const STORAGE_KEY = "cssa-hub-push";
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const listeners = new Set<() => void>();

export type PushState = "unsupported" | "ios-install" | "denied" | "off" | "on";

function isIos() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function supported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function read(): PushState {
  // iOS only offers Web Push to sites opened from the home screen.
  if (isIos() && !isStandalone()) return "ios-install";
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" && window.localStorage.getItem(STORAGE_KEY) === "1" ? "on" : "off";
}

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  window.addEventListener("storage", callback);
  let status: PermissionStatus | null = null;
  navigator.permissions
    ?.query({ name: "notifications" })
    .then((s) => {
      status = s;
      s.addEventListener("change", callback);
    })
    .catch(() => {});
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
    status?.removeEventListener("change", callback);
  };
}

export function usePushState(): PushState {
  return useSyncExternalStore(subscribe, read, () => "unsupported");
}

function register() {
  return navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` });
}

function keyBytes(base64url: string) {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array) {
  if (!a || a.byteLength !== b.length) return false;
  const view = new Uint8Array(a);
  return view.every((byte, i) => byte === b[i]);
}

/** Whether the subscription was made with this VAPID public key; true when the browser doesn't say. */
export function matchesKey(subscription: PushSubscription, publicKey: string) {
  const current = subscription.options?.applicationServerKey;
  return current == null || sameKey(current, keyBytes(publicKey));
}

export function subscriptionArgs(subscription: PushSubscription) {
  const json = subscription.toJSON();
  return { endpoint: subscription.endpoint, p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" };
}

/** This device's current subscription, registering the service worker if needed. */
export async function currentSubscription() {
  const registration = await register();
  return registration.pushManager.getSubscription();
}

export function forgetDevice() {
  window.localStorage.removeItem(STORAGE_KEY);
  emit();
}

async function unsubscribeDevice(remove: (args: { endpoint: string }) => Promise<unknown>) {
  forgetDevice();
  if (!supported()) return;
  const registration = await navigator.serviceWorker.getRegistration(`${BASE}/`);
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await remove({ endpoint: subscription.endpoint }).catch(() => {});
  await subscription.unsubscribe();
}

export function usePush() {
  const state = usePushState();
  const config = useQuery(api.push.config);
  const save = useMutation(api.push.subscribe);
  const remove = useMutation(api.push.unsubscribe);
  const sendTest = useMutation(api.push.sendTest);

  /** Returns the resulting state; call straight from a tap so iOS shows the permission prompt. */
  const enable = async (): Promise<PushState> => {
    const permission = await Notification.requestPermission();
    const publicKey = config?.publicKey;
    if (permission !== "granted" || !publicKey) {
      emit();
      return read();
    }
    const key = keyBytes(publicKey);
    const registration = await register();
    await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !matchesKey(subscription, publicKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await save(subscriptionArgs(subscription));
    window.localStorage.setItem(STORAGE_KEY, "1");
    emit();
    return read();
  };

  return {
    state,
    /** undefined while loading; false when the deployment has no VAPID keys. */
    configured: config === undefined ? undefined : config.publicKey !== null,
    enable,
    disable: () => unsubscribeDevice(remove),
    test: () => sendTest({}),
  };
}

/** Signing out also stops pushes to this device, so the next person on it doesn't get them. */
export function useSignOut() {
  const { signOut } = useAuthActions();
  const remove = useMutation(api.push.unsubscribe);
  return async () => {
    await unsubscribeDevice(remove).catch(() => {});
    // Kept files belong to this account; the next person on the device shouldn't find them.
    await clearCache().catch(() => {});
    await signOut();
  };
}
