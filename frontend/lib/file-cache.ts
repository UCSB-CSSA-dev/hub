/**
 * Files opened in the app are kept on this device (IndexedDB) so opening them again costs no
 * Convex bandwidth. Nothing expires on its own; Settings lists them and deletes by age or all at once.
 */

const DB_NAME = "cssa-hub-files";
const META = "meta";
const BLOBS = "blobs";
const DAY_MS = 24 * 60 * 60 * 1000;
const CHANGE_EVENT = "cssa-hub-file-cache";

/** Larger files are streamed each time instead of kept. */
export const MAX_CACHED_BYTES = 100 * 1024 * 1024;
export const CLEAR_AGE_DAYS = [30, 90, 180, 360] as const;

export type CachedFile = {
  key: string;
  name: string;
  contentType: string;
  size: number;
  cachedAt: number;
};

export type FileSource = { url: string; name: string; contentType: string; size: number };

/** Convex storage URLs name immutable blobs; Drive and other hosts don't allow reading them here. */
export function isCacheable(url: string) {
  try {
    return new URL(url).pathname.startsWith("/api/storage/");
  } catch {
    return false;
  }
}

function cacheKey(url: string) {
  const parsed = new URL(url);
  return parsed.origin + parsed.pathname;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb() {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(META, { keyPath: "key" });
      request.result.createObjectStore(BLOBS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
}

function done(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function changed() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onCacheChange(listener: () => void) {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

async function readCached(key: string) {
  const db = await openDb();
  return (await result(db.transaction(BLOBS).objectStore(BLOBS).get(key))) as Blob | undefined;
}

async function writeCached(meta: CachedFile, blob: Blob) {
  const db = await openDb();
  const tx = db.transaction([META, BLOBS], "readwrite");
  tx.objectStore(META).put(meta);
  tx.objectStore(BLOBS).put(blob, meta.key);
  await done(tx);
  // Ask the browser not to evict the cache under storage pressure; it may still say no.
  void navigator.storage?.persist?.().catch(() => undefined);
  changed();
}

const inFlight = new Map<string, Promise<Blob>>();

/** The file's bytes: from this device when kept, otherwise downloaded once and kept. */
export function loadFile(source: FileSource): Promise<Blob> {
  if (!isCacheable(source.url)) return fetchBlob(source.url);
  const key = cacheKey(source.url);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = (async () => {
      const cached = await readCached(key).catch(() => undefined);
      if (cached) return cached;
      const blob = await fetchBlob(source.url);
      if (blob.size <= MAX_CACHED_BYTES) {
        const meta = { key, name: source.name, contentType: source.contentType, size: blob.size, cachedAt: Date.now() };
        await writeCached(meta, blob).catch(() => undefined);
      }
      return blob;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

async function fetchBlob(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
}

export async function isCached(url: string) {
  if (!isCacheable(url)) return false;
  const db = await openDb();
  return (await result(db.transaction(META).objectStore(META).count(cacheKey(url)))) > 0;
}

export async function listCached(): Promise<CachedFile[]> {
  const db = await openDb();
  const rows = (await result(db.transaction(META).objectStore(META).getAll())) as CachedFile[];
  return rows.sort((a, b) => b.cachedAt - a.cachedAt);
}

export async function removeCached(keys: string[]) {
  if (keys.length === 0) return;
  const db = await openDb();
  const tx = db.transaction([META, BLOBS], "readwrite");
  for (const key of keys) {
    tx.objectStore(META).delete(key);
    tx.objectStore(BLOBS).delete(key);
  }
  await done(tx);
  changed();
}

/** Deletes files kept for longer than the given number of days; returns how many went. */
export async function removeOlderThan(days: number) {
  const cutoff = Date.now() - days * DAY_MS;
  const stale = (await listCached()).filter((f) => f.cachedAt < cutoff).map((f) => f.key);
  await removeCached(stale);
  return stale.length;
}

export async function clearCache() {
  const db = await openDb();
  const tx = db.transaction([META, BLOBS], "readwrite");
  tx.objectStore(META).clear();
  tx.objectStore(BLOBS).clear();
  await done(tx);
  changed();
}

/** Saves a file to the user's downloads, through the device cache. */
export async function downloadFile(source: FileSource) {
  const blob = await loadFile(source);
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = source.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}
