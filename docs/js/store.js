// Persist takes across reloads via IndexedDB (localStorage can't hold audio/video
// blobs). Two stores: "blobs" keyed by a persistent track id (pid) holds the
// original recording/file + flags (written once per take); "meta" holds one small
// "state" record with the ordered pid list, per-take settings and globals
// (rewritten on every change).
const DB = "jamyourself";
const VER = 1;

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });

export async function saveBlob(pid, rec) {
  const db = await open(); const t = db.transaction("blobs", "readwrite");
  t.objectStore("blobs").put(rec, pid); return done(t);
}
export async function deleteBlob(pid) {
  const db = await open(); const t = db.transaction("blobs", "readwrite");
  t.objectStore("blobs").delete(pid); return done(t);
}
export async function getAllBlobs() {
  const db = await open(); const t = db.transaction("blobs", "readonly");
  const s = t.objectStore("blobs");
  const keys = await req(s.getAllKeys()), vals = await req(s.getAll());
  const m = {}; keys.forEach((k, i) => { m[k] = vals[i]; }); return m;
}
export async function saveMeta(meta) {
  const db = await open(); const t = db.transaction("meta", "readwrite");
  t.objectStore("meta").put(meta, "state"); return done(t);
}
export async function getMeta() {
  const db = await open(); const t = db.transaction("meta", "readonly");
  return req(t.objectStore("meta").get("state"));
}
export async function clearAll() {
  const db = await open(); const t = db.transaction(["blobs", "meta"], "readwrite");
  t.objectStore("blobs").clear(); t.objectStore("meta").clear(); return done(t);
}

export const newPid = () =>
  (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
