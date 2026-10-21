// Dufs service worker. Its one job: "Share to Dufs" from another app on a phone. The share
// target posts the files to <assets>share-target; this keeps them in IndexedDB and opens the
// app with ?shared=<id>, where the user picks the folder and uploads them.
// Scope = the assets folder, so a stock dufs serving these files with --assets is enough.
"use strict";
const DB = "dufs-share";
// /prefix/__dufs_v0.45.0__/sw.js -> /prefix/
const APP_ROOT = self.location.pathname.replace(/__dufs_v[^/]*__\/.*$/, "");

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("shares", { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function keep(rec) {
  const d = await db();
  await new Promise((res, rej) => {
    const tx = d.transaction("shares", "readwrite");
    const st = tx.objectStore("shares");
    // shares older than a day were abandoned
    const old = Date.now() - 86400000;
    st.openCursor().onsuccess = ev => { const c = ev.target.result; if (c) { if (c.value.at < old) c.delete(); c.continue(); } };
    st.put(rec);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  d.close();
}
async function receive(request) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter(f => f && typeof f === "object");
    const str = k => { const v = form.get(k); return typeof v === "string" ? v : ""; };
    await keep({
      id, at: Date.now(), title: str("title"), text: str("text"), url: str("url"),
      files: files.map(f => ({ name: f.name || "shared", type: f.type || "", blob: f })),
    });
  } catch (err) {
    return Response.redirect(APP_ROOT + "?shared-error=" + encodeURIComponent(String(err && err.message || err)), 303);
  }
  return Response.redirect(APP_ROOT + "?shared=" + id, 303);
}
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.pathname.endsWith("/share-target")) e.respondWith(receive(e.request));
});
