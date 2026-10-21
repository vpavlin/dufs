// Dufs - the web app: the Dufs Basecamp app's browser, preview and transfers, served by dufs
// itself, installable as a PWA (manifest + service worker) with "share to Dufs" from a phone.
//
// One page. Folders load as JSON (`?json`) and the address bar follows with pushState, so the
// back button and links work as before. Uploads are PUT (resumed with PATCH + X-Update-Range),
// folders MKCOL, renames MOVE, deletes DELETE: the same dufs API the old page used.
"use strict";

// ── what the server put in the page ────────────────────────────────────────────────────────────
const DATA = (() => {
  try {
    const b = atob(document.getElementById("index-data").innerHTML.trim());
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(b, c => c.charCodeAt(0))));
  } catch (e) {
    return { kind: "Index", href: "/", uri_prefix: "/", paths: [] };
  }
})();
const ASSETS = window.DUFS_ASSETS || "/";
const PREFIX = DATA.uri_prefix || "/";               // "/" or "/files/"
const ROOT = PREFIX.replace(/\/$/, "");              // "" or "/files"
const VERSION = (ASSETS.match(/__dufs_v([^_]+)__/) || [])[1] || "";
const STORE_KEY = "dufs:" + location.host + PREFIX;

// ── small helpers ──────────────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const enc = p => p.split("/").map(encodeURIComponent).join("/");
const urlFor = path => ROOT + enc(path);
const absUrl = path => location.origin + urlFor(path);
const isDirPath = p => p.endsWith("/");
const parentOf = p => { const s = p.replace(/\/$/, ""); return s.substring(0, s.lastIndexOf("/") + 1) || "/"; };
const baseName = p => { const s = p.replace(/\/$/, ""); return s.substring(s.lastIndexOf("/") + 1) || "/"; };
const narrow = () => matchMedia("(max-width: 760px)").matches;
function load(key, fb) { try { const v = JSON.parse(localStorage.getItem(STORE_KEY + key)); return v === null ? fb : v; } catch { return fb; } }
function save(key, v) { try { localStorage.setItem(STORE_KEY + key, JSON.stringify(v)); } catch { } }

function fmtSize(n, dir) {
  // dufs caps a folder's count at 1000
  if (dir) return n === 1 ? "1 item" : (n >= 1000 ? "1000+ items" : (n || 0) + " items");
  if (n === undefined || n === null) return "";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + " " + u[i];
}
function fmtDate(ms) {
  if (!ms) return "";
  const d = new Date(ms), now = new Date();
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d.toDateString() === now.toDateString()) return "Today " + t;
  const o = { day: "numeric", month: "short" };
  if (d.getFullYear() !== now.getFullYear()) o.year = "numeric";
  return d.toLocaleDateString(undefined, o) + " " + t;
}
const EXT = {
  image: "png jpg jpeg gif webp bmp svg avif ico heic heif",
  video: "mp4 webm mov mkv m4v ogv avi",
  audio: "mp3 m4a aac ogg oga opus wav flac",
  text: "txt md markdown mdown mkd log json jsonl yaml yml toml ini conf cfg csv tsv xml html htm xhtml css js mjs ts jsx tsx py rs go c h cc cpp hpp java kt sh bash zsh fish sql nix lua rb php pl swift dart qml env gitignore dockerfile makefile srt vtt diff patch lidl scad",
  archive: "zip tar gz tgz bz2 xz 7z rar zst lgx apk",
  document: "pdf doc docx odt xls xlsx ods ppt pptx odp epub rtf",
};
const KIND = {};
for (const [k, list] of Object.entries(EXT)) for (const e of list.split(" ")) KIND[e] = k;
function kindOf(name, dir) {
  if (dir) return "dir";
  const n = name.toLowerCase(), dot = n.lastIndexOf(".");
  if (dot < 0) return /^(readme|license|makefile|dockerfile|changelog|authors|copying|notice)$/.test(n) ? "text" : "";
  return KIND[n.slice(dot + 1)] || "";
}
const GLYPH = { dir: "▤", image: "▣", text: "≣", video: "▶", audio: "♪", archive: "▧", document: "▤" };
const COLOR = { dir: "var(--accent)", image: "#6fb6ff", text: "#b5a2ff", video: "#ff6fae", audio: "#ffcf5c", archive: "#8fd18f" };
const glyph = k => GLYPH[k] || "□";
const kindColor = k => COLOR[k] || "var(--faint)";
const isMarkdown = n => /\.(md|markdown|mdown|mkdn?)$/i.test(n);
const isHtml = n => /\.(html?|xhtml)$/i.test(n);

// ── state ──────────────────────────────────────────────────────────────────────────────────────
const S = {
  path: "/",
  entries: [],
  perms: { upload: false, delete: false, search: false, archive: false },
  auth: !!DATA.auth,
  user: DATA.user || null,
  dirExists: true,
  query: "",
  sel: null,            // selected entry path
  editing: false,
  source: false,        // markdown/html: show the source
  grid: load("grid", false),
  sort: load("sort", { k: "name", asc: true }),
  loading: false,
  error: "",            // "auth" | "missing" | message
  sig: "",
};

// ── markdown, rendered here: escaped first, so a file can't inject markup ──────────────────────
function mdToHtml(src, baseDir) {
  const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const safeHref = (href, img) => {
    const u = href.trim();
    if (/^(https?:|mailto:)/i.test(u)) return img ? null : u;          // no remote images: they would fetch
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null;                     // javascript:, data:, ...
    if (u.startsWith("#")) return u;
    return u.startsWith("/") ? ROOT + u : urlFor(baseDir) + u;
  };
  function inline(t) {
    const keep = [];
    const stash = x => { keep.push(x); return "\u0000" + (keep.length - 1) + "\u0000"; };
    t = t.replace(/`([^`]+)`/g, (m, c) => stash("<code>" + esc(c) + "</code>"));
    t = t.replace(/!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (m, alt, href) => {
      const u = safeHref(href, true);
      return stash(u ? '<img alt="' + esc(alt) + '" src="' + esc(u) + '" loading="lazy">' : esc(alt));
    });
    t = t.replace(/\[([^\]]+)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (m, label, href) => {
      const u = safeHref(href, false);
      return stash(u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + "</a>" : esc(label));
    });
    t = t.replace(/<(https?:\/\/[^\s>]+)>/g, (m, u) => stash('<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + "</a>"));
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]*[^\s<).,;:!?])/g, (m, pre, u) => pre + stash('<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + "</a>"));
    t = esc(t);
    t = t.replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, "<b>$1</b>").replace(/__(\S(?:[^_]*\S)?)__/g, "<b>$1</b>");
    t = t.replace(/(^|[^\w*])\*(\S(?:[^*]*\S)?)\*/g, "$1<i>$2</i>").replace(/(^|[^\w])_(\S(?:[^_]*\S)?)_(?!\w)/g, "$1<i>$2</i>");
    t = t.replace(/~~(\S(?:[^~]*\S)?)~~/g, "<s>$1</s>");
    return t.replace(/\u0000(\d+)\u0000/g, (m, i) => keep[+i]);
  }
  const cells = l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
  const lines = String(src || "").replace(/\r/g, "").split("\n"), out = [];
  let para = [], list = null;
  const flush = () => { if (para.length) { out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; } };
  const closeList = () => { if (list) { out.push("</" + list + ">"); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; let m;
    if ((m = l.match(/^\s{0,3}(```|~~~)/))) {
      flush(); closeList();
      const code = [];
      for (i++; i < lines.length && lines[i].trim().indexOf(m[1]) !== 0; i++) code.push(lines[i]);
      out.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>");
      continue;
    }
    if (/^\s*$/.test(l)) { flush(); closeList(); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); closeList(); out.push("<hr>"); continue; }
    if ((m = l.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      flush(); closeList();
      const n = m[1].length;
      out.push("<h" + n + ">" + inline(m[2]) + "</h" + n + ">");
      continue;
    }
    if (/^\s*>/.test(l)) {
      flush(); closeList();
      const q = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ""));
      i--;
      out.push("<blockquote>" + mdToHtml(q.join("\n"), baseDir) + "</blockquote>");
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush(); closeList();
      const head = cells(l); i += 2;
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      out.push("<table><tr>" + head.map(c => "<th>" + inline(c) + "</th>").join("") + "</tr>" +
        rows.map(r => "<tr>" + r.map(c => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") + "</table>");
      continue;
    }
    if ((m = l.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/))) {
      flush();
      const kind = /\d/.test(m[1]) ? "ol" : "ul";
      if (list !== kind) { closeList(); out.push("<" + kind + ">"); list = kind; }
      const t = m[2].replace(/^\[( |x)\]\s+/i, (x, c) => (c.trim() ? "☑ " : "☐ "));
      out.push("<li>" + inline(t) + "</li>");
      continue;
    }
    closeList();
    para.push(l.trim());
  }
  flush(); closeList();
  return out.join("\n");
}

// ── toasts ─────────────────────────────────────────────────────────────────────────────────────
let toastTimer = 0;
function toast(text, bad) {
  const t = $("toast");
  t.textContent = text; t.classList.toggle("bad", !!bad); t.classList.remove("hidden");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), 4200);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = h("textarea", { style: "position:fixed;opacity:0" }); ta.value = text;
    document.body.append(ta); ta.select(); try { document.execCommand("copy"); } catch { } ta.remove();
  }
  toast("Copied");
}

// ── menus and dialogs ──────────────────────────────────────────────────────────────────────────
function openMenu(items, anchor, title) {
  const m = $("menu");
  m.replaceChildren();
  if (title) m.append(h("div", { class: "m-title", text: title }));
  for (const it of items) {
    if (!it) continue;
    if (it === "-") { m.append(h("hr")); continue; }
    m.append(h("button", {
      class: it.danger ? "danger" : "", disabled: it.disabled,
      onclick: () => { closeMenu(); it.run(); },
    }, it.label));
  }
  m.classList.remove("hidden");
  if (!narrow() && anchor) {
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const w = m.offsetWidth, hh = m.offsetHeight;
    let x = Math.min(r.right - w, innerWidth - w - 8); if (r.width === undefined) x = Math.min(r.left, innerWidth - w - 8);
    let y = r.bottom + 4; if (y + hh > innerHeight - 8) y = Math.max(8, r.top - hh - 4);
    m.style.left = Math.max(8, x) + "px"; m.style.top = y + "px";
  }
}
function closeMenu() { $("menu").classList.add("hidden"); }
document.addEventListener("pointerdown", e => {
  if (!$("menu").classList.contains("hidden") && !$("menu").contains(e.target)) { closeMenu(); e.stopPropagation(); }
}, true);

let dlgDone = null;
function dialog({ title, text, input, buttons }) {
  return new Promise(resolve => {
    $("dlg-title").textContent = title || "";
    $("dlg-text").textContent = text || "";
    const inp = $("dlg-input");
    inp.classList.toggle("hidden", input === undefined);
    inp.value = input || "";
    const box = $("dlg-buttons"); box.replaceChildren();
    const finish = v => { $("dialog").classList.add("hidden"); dlgDone = null; resolve(v); };
    dlgDone = finish;
    buttons.forEach((b, i) => {
      if (b === "|") { box.append(h("span", { class: "spacer" })); return; }
      box.append(h("button", {
        class: "btn" + (b.primary ? " primary" : "") + (b.danger ? " danger" : ""),
        onclick: () => finish(input !== undefined ? (b.value ? inp.value.trim() : null) : b.value),
      }, b.label));
    });
    $("dialog").classList.remove("hidden");
    if (input !== undefined) {
      inp.focus();
      const dot = inp.value.lastIndexOf(".");
      inp.setSelectionRange(0, dot > 0 ? dot : inp.value.length);
      inp.onkeydown = e => {
        if (e.key === "Enter") { e.preventDefault(); finish(inp.value.trim()); }
      };
    }
  });
}
$("dialog").addEventListener("click", e => { if (e.target === $("dialog") && dlgDone) dlgDone(null); });
const askName = (title, value, ok) => dialog({ title, input: value, buttons: [{ label: "Cancel" }, "|", { label: ok || "OK", primary: true, value: true }] })
  .then(v => (v ? v : null));
const confirmAsk = (title, text, ok, danger) => dialog({ title, text, buttons: [{ label: "Cancel", value: false }, "|", { label: ok, primary: !danger, danger, value: true }] });
const badName = n => !n || n === "." || n === ".." || /[\/\\]/.test(n);

// ── places: pinned + recent, per server, in this browser ───────────────────────────────────────
let places = load("places", { pins: [], recent: [] });
const isPinned = p => places.pins.some(x => x.path === p);
function togglePin(p) {
  if (isPinned(p)) { places.pins = places.pins.filter(x => x.path !== p); toast("Unpinned " + baseName(p)); }
  else { places.pins.push({ path: p }); toast("Pinned " + baseName(p)); }
  save("places", places); renderPlaces(); renderToolbar();
}
function noteRecent(p) {
  if (p === "/") return;
  places.recent = [{ path: p }].concat(places.recent.filter(x => x.path !== p)).slice(0, 12);
  save("places", places); renderPlaces();
}
function openPlace(p) {
  closeSide();
  if (isDirPath(p)) go(p);
  else go(parentOf(p), { sel: p });
}
function renderPlaces() {
  const box = $("places"); box.replaceChildren();
  const recent = places.recent.filter(r => !isPinned(r.path));
  const row = (pl, pinned) => {
    const dir = isDirPath(pl.path);
    const here = dir ? S.path === pl.path : S.sel === pl.path;
    return h("div", { class: "place" + (here ? " here" : ""), onclick: () => openPlace(pl.path), title: pl.path },
      h("span", { class: "glyph", style: "color:" + kindColor(dir ? "dir" : kindOf(pl.path, false)), text: glyph(dir ? "dir" : kindOf(pl.path, false)) }),
      h("span", { class: "txt" }, h("span", { class: "nm", text: baseName(pl.path) }), h("span", { class: "dir", text: parentOf(pl.path) })),
      h("button", {
        class: "x", title: pinned ? "Unpin" : "Pin", text: pinned ? "✕" : "☆",
        onclick: e => { e.stopPropagation(); togglePin(pl.path); },
      }));
  };
  if (places.pins.length) {
    box.append(h("div", { class: "label", text: "PINNED" }));
    places.pins.forEach(p => box.append(row(p, true)));
  }
  if (recent.length) {
    box.append(h("div", { class: "label row" }, h("span", { class: "grow", text: "RECENT" }),
      h("button", { class: "link small", text: "Clear", onclick: () => { places.recent = []; save("places", places); renderPlaces(); } })));
    recent.forEach(p => box.append(row(p, false)));
  }
  if (!places.pins.length && !recent.length)
    box.append(h("div", { class: "hint", text: "Pin a file or folder from its ⋯ menu or the ☆ in the toolbar. Folders and files you open show up here as Recent." }));
}

// ── loading a folder ───────────────────────────────────────────────────────────────────────────
let loadSeq = 0;
function setEntries(d, path) {
  S.perms = { upload: !!d.allow_upload, delete: !!d.allow_delete, search: !!d.allow_search, archive: !!d.allow_archive };
  S.auth = !!d.auth; S.user = d.user || null; S.dirExists = d.dir_exists !== false;
  S.entries = (d.paths || []).map(p => {
    const dir = p.path_type === "Dir" || p.path_type === "SymlinkDir";
    const path2 = path + p.name + (dir ? "/" : "");
    return { name: baseName(p.name), rel: p.name, path: path2, dir, size: p.size, mtime: p.mtime, kind: kindOf(p.name, dir) };
  });
}
async function fetchDir(path, query) {
  let u = urlFor(path) + "?json";
  if (query) u += "&q=" + encodeURIComponent(query);
  const res = await fetch(u, { headers: { accept: "application/json" }, cache: "no-store" });
  if (res.status === 401 || res.status === 403) { const e = new Error("auth"); e.code = res.status; throw e; }
  if (res.status === 404) { const e = new Error("missing"); e.code = 404; throw e; }
  if (!res.ok) throw new Error(res.status + " " + res.statusText);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("json")) throw new Error("This folder answered with a page, not a listing");
  return res.json();
}
// Opens a folder. opts: push (default true), sel (a file to select), query, quiet (no spinner, keep selection).
async function go(path, opts = {}) {
  if (!isDirPath(path)) path += "/";
  const seq = ++loadSeq;
  const changed = path !== S.path;
  if (!opts.quiet) { S.loading = true; renderLoading(); }
  if (changed && !opts.quiet) { S.query = opts.query || ""; $("search").value = S.query; }
  const query = opts.query !== undefined ? opts.query : (changed ? "" : S.query);
  try {
    const d = await fetchDir(path, query);
    if (seq !== loadSeq) return;
    const sig = JSON.stringify(d.paths) + d.user + d.allow_upload;
    if (opts.quiet && sig === S.sig && path === S.path) return;
    S.sig = sig;
    S.path = path; S.query = query; S.error = "";
    setEntries(d, path);
    if (opts.sel !== undefined) S.sel = opts.sel;
    else if (changed) S.sel = null;
    if (S.sel && !S.entries.some(e => e.path === S.sel) && !opts.sel) S.sel = null;
  } catch (e) {
    if (seq !== loadSeq) return;
    if (opts.quiet) return;
    S.path = path; S.entries = []; S.sel = null; S.sig = "";
    S.error = e.message === "auth" ? "auth" : e.message === "missing" ? "missing" : e.message;
  } finally {
    if (seq === loadSeq) { S.loading = false; renderLoading(); }
  }
  if (opts.push !== false && !opts.quiet) {
    const st = { path: S.path, sel: S.sel };
    const url = urlFor(S.path) + location.search.replace(/[?&](shared|shared-error)=[^&]*/g, "").replace(/^&/, "?");
    if (changed) history.pushState(st, "", url); else history.replaceState(st, "", url);
  }
  if (changed && !opts.quiet) { noteRecent(S.path); $("list").scrollTop = 0; }
  if (opts.edit) S.editing = true;
  render();
}
const refresh = quiet => go(S.path, { push: false, quiet, sel: S.sel });

window.addEventListener("popstate", e => {
  const st = e.state || { path: decodeURIComponent(location.pathname.slice(ROOT.length)) || "/", sel: null };
  closeMenu();
  if (dlgDone) dlgDone(null);
  if (st.path === S.path) { selectEntry(st.sel, { history: false }); return; }
  go(st.path, { push: false, sel: st.sel });
});

// ── rendering ──────────────────────────────────────────────────────────────────────────────────
function renderLoading() { $("loadbar").classList.toggle("hidden", !S.loading); }
function sorted() {
  const { k, asc } = S.sort, m = asc ? 1 : -1;
  return S.entries.slice().sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    let r = 0;
    if (k === "size") r = (a.size || 0) - (b.size || 0);
    else if (k === "mtime") r = (a.mtime || 0) - (b.mtime || 0);
    if (!r) r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    return r * m;
  });
}
function render() {
  renderSide(); renderToolbar(); renderBanner(); renderList(); renderPreview(); renderPlaces();
  document.title = (S.path === "/" ? location.host : baseName(S.path)) + " - Dufs";
}
function renderSide() {
  $("version").textContent = VERSION ? "v" + VERSION : "";
  $("server-name").textContent = location.hostname;
  $("server-line").textContent = location.host + PREFIX + (S.user ? "  ·  " + S.user : "");
  const acc = $("account"); acc.replaceChildren();
  if (S.auth) {
    if (S.user) acc.append(h("span", { class: "grow ellip", text: "Signed in as " + S.user }), h("button", { class: "link", text: "Log out", onclick: logout }));
    else acc.append(h("span", { class: "grow", text: "Not signed in" }), h("button", { class: "link", text: "Log in", onclick: login }));
  }
}
function renderCrumbs() {
  const nav = $("crumbs"); nav.replaceChildren();
  const parts = S.path.split("/").filter(Boolean);
  const out = [{ label: location.hostname, path: "/" }];
  let acc = "/";
  for (const p of parts) { acc += p + "/"; out.push({ label: p, path: acc }); }
  out.forEach((c, i) => {
    if (i) nav.append(h("span", { class: "sep", text: "/" }));
    nav.append(h("a", { class: c.path === S.path ? "cur" : "", href: urlFor(c.path), text: c.label, onclick: e => { e.preventDefault(); go(c.path); } }));
  });
  nav.scrollLeft = nav.scrollWidth;
}
function renderToolbar() {
  renderCrumbs();
  const ok = !S.error, up = ok && S.perms.upload && !S.query;
  $("search-form").style.visibility = S.perms.search ? "" : "hidden";
  $("search-btn").classList.toggle("hidden", !S.perms.search);
  $("search-clear").classList.toggle("hidden", !$("search").value && !S.query);
  $("pin-btn").textContent = isPinned(S.path) ? "★" : "☆";
  $("pin-btn").title = isPinned(S.path) ? "Unpin this folder" : "Pin this folder";
  $("view-btn").textContent = S.grid ? "List" : "Grid";
  $("mkdir-btn").disabled = !up;
  $("upload-btn").disabled = !up;
  $("fab").classList.toggle("hidden", !up || !!S.sel && narrow());
}
function renderBanner() {
  const b = $("banner"); b.replaceChildren(); b.className = "banner hidden";
  const show = (bad, ...kids) => { b.className = "banner" + (bad ? " bad" : ""); b.append(...kids); };
  if (S.error === "auth") show(true, h("span", { class: "grow", text: S.user ? "You can't open this folder as " + S.user + "." : "This folder needs you to log in." }), h("button", { class: "btn", text: "Log in", onclick: login }));
  else if (S.error === "missing") show(true, h("span", { class: "grow", text: "This folder doesn't exist (any more)." }), h("button", { class: "btn", text: "Go up", onclick: goUp }));
  else if (S.error) show(true, h("span", { class: "grow", text: S.error }), h("button", { class: "btn", text: "Open in browser", onclick: () => window.open(urlFor(S.path), "_blank") }));
  else if (S.query) show(false, h("span", { class: "grow", text: "Results for “" + S.query + "” in " + S.path }), h("button", { class: "btn", text: "Clear", onclick: clearSearch }));
  else if (S.entries.some(e => e.name.toLowerCase() === "index.html" && !e.dir))
    show(false, h("span", { class: "grow", text: "This folder is a web page (it has an index.html)." }),
      h("button", { class: "btn", text: "Open page", onclick: () => window.open(urlFor(S.path + "index.html"), "_blank") }),
      h("button", { class: "btn", text: "Copy link", onclick: () => copyText(absUrl(S.path)) }));
}
function entryMenuItems(e) {
  const canShare = !!navigator.share;
  return [
    { label: e.dir ? "Open" : "Preview", run: () => activate(e) },
    { label: e.dir ? "Download as .zip" : "Download", disabled: e.dir && !S.perms.archive, run: () => download(e) },
    { label: "Copy link", run: () => copyText(absUrl(e.path)) },
    canShare && { label: e.dir ? "Share link…" : "Share…", run: () => shareEntry(e) },
    { label: isPinned(e.path) ? "Unpin" : "Pin", run: () => togglePin(e.path) },
    { label: "Open in browser", run: () => window.open(urlFor(e.path), "_blank", "noopener") },
    !e.dir && kindOf(e.name) === "text" && S.perms.upload && S.perms.delete && { label: "Edit", run: () => { selectEntry(e.path); startEdit(); } },
    "-",
    { label: "Rename", disabled: !(S.perms.upload && S.perms.delete), run: () => renamePath(e) },
    { label: "Delete", danger: true, disabled: !S.perms.delete, run: () => deletePath(e) },
  ];
}
function attachPress(el, e) {
  // right-click on a desktop, long-press on a phone: the entry's menu
  el.addEventListener("contextmenu", ev => { ev.preventDefault(); openMenu(entryMenuItems(e), { x: ev.clientX, y: ev.clientY }, e.name); });
  let t = 0, sx = 0, sy = 0;
  el.addEventListener("touchstart", ev => {
    sx = ev.touches[0].clientX; sy = ev.touches[0].clientY;
    t = setTimeout(() => { t = -1; navigator.vibrate && navigator.vibrate(15); openMenu(entryMenuItems(e), el, e.name); }, 480);
  }, { passive: true });
  el.addEventListener("touchmove", ev => { if (t > 0 && Math.hypot(ev.touches[0].clientX - sx, ev.touches[0].clientY - sy) > 10) { clearTimeout(t); t = 0; } }, { passive: true });
  el.addEventListener("touchend", ev => { if (t > 0) clearTimeout(t); if (t === -1) ev.preventDefault(); t = 0; });
}
function renderList() {
  const list = $("list");
  list.replaceChildren();
  list.className = "list" + (S.grid ? " grid" : "");
  $("list-head").classList.toggle("hidden", S.grid || !!S.error);
  document.querySelectorAll("#list-head button").forEach(b => {
    b.classList.toggle("on", b.dataset.sort === S.sort.k);
    b.textContent = { name: "Name", size: "Size", mtime: "Modified" }[b.dataset.sort] + (b.dataset.sort === S.sort.k ? (S.sort.asc ? " ↑" : " ↓") : "");
  });
  $("up-row").classList.toggle("hidden", S.path === "/" || S.grid);
  const items = sorted();
  const empty = $("empty"); empty.replaceChildren(); empty.classList.add("hidden");
  if (!items.length && !S.error && !S.loading) {
    empty.classList.remove("hidden");
    empty.append(h("div", { text: S.query ? "No results" : S.dirExists ? "Empty folder" : "This folder is created when a file is uploaded" }));
    if (S.perms.upload && !S.query) empty.append(h("button", { class: "btn", text: "Upload files", onclick: () => $("file-input").click() }));
  }
  const frag = document.createDocumentFragment();
  for (const e of items) {
    const sub = S.query && e.rel.includes("/") ? parentOf("/" + e.rel) : "";
    if (S.grid) {
      const thumb = h("div", { class: "thumb", style: "color:" + kindColor(e.kind) });
      if (e.kind === "image" && e.size < 20e6 && !/\.(heic|heif)$/i.test(e.name)) {
        const img = h("img", { loading: "lazy", decoding: "async", alt: "", src: urlFor(e.path) });
        img.onerror = () => { img.remove(); thumb.textContent = glyph(e.kind); };
        thumb.append(img);
      } else thumb.textContent = glyph(e.kind);
      const cell = h("div", { class: "cell" + (S.sel === e.path ? " sel" : ""), title: e.name, onclick: () => activate(e) },
        thumb, h("div", { class: "name", text: e.name }), h("div", { class: "sub", text: sub || fmtSize(e.size, e.dir) }));
      attachPress(cell, e);
      frag.append(cell);
    } else {
      const row = h("div", { class: "row entry" + (S.sel === e.path ? " sel" : ""), "data-path": e.path, onclick: () => activate(e), ondblclick: () => !e.dir && window.open(urlFor(e.path), "_blank", "noopener") },
        h("span", { class: "glyph", style: "color:" + kindColor(e.kind), text: glyph(e.kind) }),
        h("span", { class: "txt name" },
          h("span", { class: "ellip", style: "display:block", text: e.name }),
          h("span", { class: "sub", text: [sub, fmtSize(e.size, e.dir), fmtDate(e.mtime)].filter(Boolean).join("  ·  ") })),
        h("span", { class: "size", text: fmtSize(e.size, e.dir) }),
        h("span", { class: "date", text: fmtDate(e.mtime) }),
        h("button", { class: "act", title: "More", text: "⋯", onclick: ev => { ev.stopPropagation(); openMenu(entryMenuItems(e), ev.currentTarget, e.name); } }));
      attachPress(row, e);
      frag.append(row);
    }
  }
  list.append(frag);
}
function activate(e) {
  if (e.dir) go(e.path);
  else selectEntry(e.path);
}
function goUp() { if (S.path !== "/") go(parentOf(S.path)); }

// ── preview ────────────────────────────────────────────────────────────────────────────────────
let pvFor = "", pvText = null, pvTextFor = "";
function selectEntry(path, { history: hist = true } = {}) {
  const was = S.sel;
  S.sel = path || null; S.editing = false; S.source = false;
  if (S.sel) noteRecent(S.sel);
  if (hist && S.sel !== was) {
    const st = { path: S.path, sel: S.sel };
    // on a phone the preview is a screen of its own: Back closes it
    if (narrow() && S.sel && !was) history.pushState(st, "", location.href);
    else history.replaceState(st, "", location.href);
  }
  renderList(); renderPreview(); renderToolbar(); renderPlaces();
}
function closePreview() {
  if (narrow() && history.state && history.state.sel) history.back();
  else selectEntry(null);
}
function selectedEntry() { return S.entries.find(e => e.path === S.sel) || null; }
async function loadText(e) {
  if (pvTextFor === e.path + e.mtime && pvText !== null) return pvText;
  const res = await fetch(urlFor(e.path), { cache: "no-store" });
  if (!res.ok) throw new Error(res.status + " " + res.statusText);
  pvText = await res.text(); pvTextFor = e.path + e.mtime;
  return pvText;
}
function renderPreview() {
  const e = selectedEntry(), pv = $("preview");
  pv.classList.toggle("hidden", !e);
  $("pv-divider").classList.toggle("hidden", !e);
  if (!e) { pvFor = ""; $("pv-body").replaceChildren(); return; }
  const key = e.path + "|" + e.mtime + "|" + S.source + "|" + S.editing;
  $("pv-name").textContent = e.name;
  $("pv-meta").textContent = fmtSize(e.size, false) + (e.mtime ? "  ·  " + fmtDate(e.mtime) : "");
  const tabs = $("pv-tabs");
  tabs.classList.toggle("hidden", !(isMarkdown(e.name) || isHtml(e.name)) || S.editing);
  tabs.querySelectorAll("button").forEach(b => b.classList.toggle("on", (b.dataset.src === "1") === S.source));
  renderPvActions(e);
  if (key === pvFor) return;
  pvFor = key;
  const body = $("pv-body"); body.replaceChildren();
  const big = (...kids) => body.append(h("div", { class: "big" }, h("div", { class: "g", style: "color:" + kindColor(e.kind), text: glyph(e.kind) }), ...kids));
  const url = urlFor(e.path);
  const textish = e.kind === "text" && e.size <= 4 * 1024 * 1024;
  if (S.editing) {
    const ta = h("textarea", { spellcheck: "false", "aria-label": "Edit " + e.name });
    ta.value = "Loading…"; ta.disabled = true;
    body.append(ta);
    loadText(e).then(t => { ta.value = t; ta.disabled = false; ta.focus(); }).catch(err => { ta.value = "Couldn't load: " + err.message; });
    return;
  }
  if (e.kind === "image") {
    const img = h("img", { src: url, alt: e.name, onclick: () => showViewer(url) });
    img.onerror = () => { body.replaceChildren(); big(h("div", { text: "This image can't be shown here." })); };
    body.append(img);
  } else if (e.kind === "video") {
    body.append(h("video", { src: url, controls: true, preload: "metadata", playsinline: true }));
  } else if (e.kind === "audio") {
    big(h("audio", { src: url, controls: true, preload: "metadata" }));
  } else if (/\.pdf$/i.test(e.name) && !narrow()) {
    body.append(h("iframe", { src: url, title: e.name }));
  } else if (isHtml(e.name) && !S.source) {
    // a sandbox with nothing allowed: no scripts, no forms, not even its own origin
    body.append(h("iframe", { src: url, sandbox: "", title: e.name, referrerpolicy: "no-referrer" }));
  } else if (textish || (isHtml(e.name) && S.source)) {
    const pre = h("pre", { text: "Loading…" });
    body.append(pre);
    loadText(e).then(t => {
      if (pvFor !== key) return;
      if (isMarkdown(e.name) && !S.source) { body.replaceChildren(h("div", { class: "md" })); body.firstChild.innerHTML = mdToHtml(t, parentOf(e.path)); }
      else pre.textContent = t;
    }).catch(err => { pre.textContent = "Couldn't load: " + err.message; });
  } else {
    big(h("div", { text: e.kind === "text" ? "Too big to show here." : "No preview for this kind of file." }),
      e.size <= 1024 * 1024 ? h("button", { class: "btn", text: "Show as text", onclick: () => { e.kind = "text"; pvFor = ""; renderPreview(); } }) : null);
  }
}
function renderPvActions(e) {
  const a = $("pv-actions"); a.replaceChildren();
  if (S.editing) {
    a.append(h("button", { class: "btn", text: "Cancel", onclick: () => { S.editing = false; renderPreview(); } }),
      h("button", { class: "btn primary", text: "Save", onclick: saveEdit }));
    return;
  }
  a.append(h("button", { class: "btn", text: "Download", onclick: () => download(e) }),
    h("button", { class: "btn", text: "Open", onclick: () => window.open(urlFor(e.path), "_blank", "noopener") }));
  if (e.kind === "text" && S.perms.upload && S.perms.delete && e.size <= 4 * 1024 * 1024)
    a.append(h("button", { class: "btn", text: "Edit", onclick: startEdit }));
  a.append(h("button", { class: "btn sq", text: "⋯", title: "More", onclick: ev => openMenu(entryMenuItems(e), ev.currentTarget, e.name) }));
}
function startEdit() { S.editing = true; S.source = false; renderPreview(); }
async function saveEdit() {
  const e = selectedEntry(), ta = $("pv-body").querySelector("textarea");
  if (!e || !ta || ta.disabled) return;
  try {
    const res = await fetch(urlFor(e.path), { method: "PUT", body: ta.value });
    if (!res.ok) throw new Error(res.status + " " + res.statusText);
    pvText = ta.value; S.editing = false; toast("Saved " + e.name);
    await refresh(true); pvTextFor = ""; pvFor = ""; renderPreview();
  } catch (err) { toast("Couldn't save: " + err.message, true); }
}
function showViewer(url) {
  const v = h("div", { class: "viewer", onclick: () => v.remove() }, h("img", { src: url, alt: "" }));
  document.body.append(v);
}
$("pv-tabs").addEventListener("click", ev => { const b = ev.target.closest("button"); if (!b) return; S.source = b.dataset.src === "1"; renderPreview(); });
$("pv-close").onclick = closePreview;
$("pv-back").onclick = closePreview;

// resizing the preview pane
(() => {
  const d = $("pv-divider"); let x0 = 0, w0 = 0;
  const w = load("pvw", 380); document.documentElement.style.setProperty("--pv-w", w + "px");
  d.addEventListener("pointerdown", e => {
    x0 = e.clientX; w0 = $("preview").offsetWidth; d.setPointerCapture(e.pointerId); d.classList.add("drag");
  });
  d.addEventListener("pointermove", e => {
    if (!d.classList.contains("drag")) return;
    const nw = Math.max(260, Math.min(innerWidth - 560, w0 - (e.clientX - x0)));
    document.documentElement.style.setProperty("--pv-w", nw + "px");
  });
  d.addEventListener("pointerup", () => { d.classList.remove("drag"); save("pvw", $("preview").offsetWidth); });
  d.addEventListener("dblclick", () => { document.documentElement.style.setProperty("--pv-w", "380px"); save("pvw", 380); });
})();

// ── file operations ────────────────────────────────────────────────────────────────────────────
function download(e) {
  const a = h("a", { href: urlFor(e.path) + (e.dir ? "?zip" : ""), download: e.dir ? e.name + ".zip" : e.name });
  document.body.append(a); a.click(); a.remove();
}
async function shareEntry(e) {
  try { await navigator.share({ title: e.name, url: absUrl(e.path) }); } catch { }
}
async function makeDir() {
  const n = await askName("New folder", "", "Create");
  if (n === null) return;
  if (badName(n)) return toast("A name can't contain / or \\", true);
  const res = await fetch(urlFor(S.path + n + "/"), { method: "MKCOL" });
  if (!res.ok) return toast("Couldn't create " + n + ": " + res.status + " " + res.statusText, true);
  toast("Created " + n);
  go(S.path + n + "/");
}
async function renamePath(e) {
  const n = await askName("Rename", e.name, "Rename");
  if (n === null || n === e.name) return;
  if (badName(n)) return toast("A name can't contain / or \\", true);
  const to = parentOf(e.path) + n + (e.dir ? "/" : "");
  const head = await fetch(urlFor(to), { method: "HEAD" });
  if (head.ok) return toast(n + " already exists here", true);
  const res = await fetch(urlFor(e.path), { method: "MOVE", headers: { Destination: absUrl(to) } });
  if (!res.ok) return toast("Couldn't rename: " + res.status + " " + res.statusText, true);
  if (S.sel === e.path) S.sel = e.dir ? null : to;
  places.pins.forEach(p => { if (p.path === e.path) p.path = to; });
  places.recent = places.recent.filter(p => p.path !== e.path);
  save("places", places);
  toast("Renamed to " + n);
  refresh();
}
async function deletePath(e) {
  const ok = await confirmAsk("Delete " + e.name + "?", e.dir ? "The folder and everything in it are removed from the server." : "The file is removed from the server.", "Delete", true);
  if (!ok) return;
  const res = await fetch(urlFor(e.path), { method: "DELETE" });
  if (!res.ok) return toast("Couldn't delete: " + res.status + " " + res.statusText, true);
  if (S.sel === e.path) S.sel = null;
  toast("Deleted " + e.name);
  refresh();
}
async function login() {
  try { await fetch(urlFor(S.path) + "?login", { method: "CHECKAUTH" }); } catch { }
  location.reload();
}
function logout() {
  const xhr = new XMLHttpRequest();
  xhr.open("LOGOUT", urlFor(S.path), true, S.user || "");
  xhr.onload = xhr.onerror = () => { location.href = urlFor(S.path); };
  xhr.send();
}

// ── search ─────────────────────────────────────────────────────────────────────────────────────
$("search-form").addEventListener("submit", e => { e.preventDefault(); const q = $("search").value.trim(); go(S.path, { query: q, push: false }); });
$("search").addEventListener("input", () => $("search-clear").classList.toggle("hidden", !$("search").value && !S.query));
$("search").addEventListener("keydown", e => { if (e.key === "Escape") { clearSearch(); $("search").blur(); } });
function clearSearch() {
  $("search").value = "";
  document.body.classList.remove("searching");
  if (S.query) go(S.path, { query: "", push: false }); else renderToolbar();
}
$("search-clear").onclick = clearSearch;
$("search-btn").onclick = () => {
  const on = document.body.classList.toggle("searching");
  if (on) $("search").focus(); else clearSearch();
};

// ── go to an address ───────────────────────────────────────────────────────────────────────────
function startAddress() {
  const a = $("addr");
  a.classList.remove("hidden"); $("crumbs").classList.add("hidden");
  a.value = absUrl(S.path); a.focus(); a.select();
}
function endAddress() { $("addr").classList.add("hidden"); $("crumbs").classList.remove("hidden"); }
$("addr").addEventListener("keydown", e => {
  if (e.key === "Escape") return endAddress();
  if (e.key !== "Enter") return;
  let v = $("addr").value.trim(), path = null;
  try {
    const u = new URL(v, location.href);
    if (u.origin !== location.origin) { location.href = u.href; return; }
    path = decodeURIComponent(u.pathname);
    if (ROOT && path.startsWith(ROOT)) path = path.slice(ROOT.length);
  } catch { path = v; }
  if (!path.startsWith("/")) path = "/" + path;
  endAddress();
  if (isDirPath(path)) go(path);
  else fetch(urlFor(path), { method: "HEAD" }).then(r => {
    // a folder without its trailing slash still answers a listing
    if (r.ok && !/text\/html/.test(r.headers.get("content-type") || "")) go(parentOf(path), { sel: path });
    else go(path + "/");
  }).catch(() => go(path + "/"));
});
$("addr").addEventListener("blur", endAddress);

// ── uploads ────────────────────────────────────────────────────────────────────────────────────
const transfers = [];
let tSeq = 0, running = 0;
const MAX_PARALLEL = 2;
function queueUpload(file, dirPath, rel, onDone) {
  const t = { id: ++tSeq, file, name: rel || file.name, dir: dirPath, size: file.size, sent: 0, offset: 0, state: "queued", speed: 0, error: "", onDone };
  transfers.push(t);
  pump(); renderTransfers();
  return t;
}
function pump() {
  while (running < MAX_PARALLEL) {
    const t = transfers.find(x => x.state === "queued");
    if (!t) break;
    running++; t.state = "running"; send(t);
  }
}
function send(t) {
  const xhr = new XMLHttpRequest(); t.xhr = xhr;
  let last = Date.now(), lastSent = 0;
  xhr.upload.onprogress = ev => {
    const now = Date.now();
    t.sent = t.offset + ev.loaded;
    if (now - last > 400) { t.speed = (t.sent - lastSent) / ((now - last) / 1000); last = now; lastSent = t.sent; }
    renderTransfers();
  };
  const end = (state, error) => {
    if (t.state !== "running") return;
    t.state = state; t.error = error || ""; t.xhr = null; running--;
    if (state === "done") { t.sent = t.size; if (t.onDone) t.onDone(t); }
    renderTransfers(); pump(); afterUploads(t);
  };
  xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? end("done") : end("failed", xhr.status + " " + (xhr.statusText || (xhr.status === 403 ? "Forbidden" : "")));
  xhr.onerror = () => end("failed", "Connection lost");
  xhr.onabort = () => end("canceled");
  const url = urlFor(t.dir + t.name);
  if (t.offset > 0) { xhr.open("PATCH", url); xhr.setRequestHeader("X-Update-Range", "append"); xhr.send(t.file.slice(t.offset)); }
  else { xhr.open("PUT", url); xhr.send(t.file); }
}
async function retryTransfer(t) {
  // resume where the server got to, if it kept a partial file
  t.offset = 0;
  try {
    const r = await fetch(urlFor(t.dir + t.name), { method: "HEAD", cache: "no-store" });
    if (r.ok) { const n = parseInt(r.headers.get("content-length") || "0", 10); if (n > 0 && n < t.size) t.offset = n; }
  } catch { }
  t.state = "queued"; t.error = ""; t.sent = t.offset;
  pump(); renderTransfers();
}
let refreshAfter = 0;
function afterUploads(t) {
  if (t.state === "done" && (t.dir === S.path || (t.dir + t.name).startsWith(S.path))) {
    clearTimeout(refreshAfter); refreshAfter = setTimeout(() => refresh(true), 300);
  }
  const active = transfers.filter(x => x.state === "running" || x.state === "queued").length;
  if (!active) {
    const done = transfers.filter(x => x.state === "done" && !x.told);
    const failed = transfers.filter(x => x.state === "failed" && !x.told);
    if (done.length || failed.length) {
      done.concat(failed).forEach(x => x.told = true);
      if (failed.length) toast(failed.length + " upload" + (failed.length > 1 ? "s" : "") + " failed: tap ↻ in Transfers to retry", true);
      else toast("Uploaded " + (done.length === 1 ? done[0].name : done.length + " files"));
    }
  }
}
function renderTransfers() {
  const box = $("transfers"), list = $("transfer-list");
  box.classList.toggle("hidden", !transfers.length);
  list.replaceChildren();
  for (const t of transfers.slice().reverse()) {
    const pct = t.size ? Math.min(100, Math.round(t.sent / t.size * 100)) : (t.state === "done" ? 100 : 0);
    let state;
    if (t.state === "running") state = [pct + "%", fmtSize(t.sent) + " of " + fmtSize(t.size), t.speed ? fmtSize(t.speed) + "/s" : ""];
    else if (t.state === "queued") state = ["Waiting"];
    else if (t.state === "done") state = ["Uploaded to " + t.dir];
    else if (t.state === "canceled") state = ["Canceled"];
    else state = ["Failed: " + t.error];
    list.append(h("div", { class: "tr " + t.state },
      h("div", { class: "tr-top" },
        h("span", { style: "color:var(--accent)", text: "↑" }),
        h("span", { class: "tr-name", title: t.dir + t.name, text: t.name }),
        (t.state === "failed" || t.state === "canceled") ? h("button", { title: "Retry", text: "↻", onclick: () => retryTransfer(t) }) : null,
        (t.state === "running" || t.state === "queued") ? h("button", { title: "Cancel", text: "✕", onclick: () => { if (t.xhr) t.xhr.abort(); else { t.state = "canceled"; renderTransfers(); } } }) : null),
      h("div", { class: "tr-state" }, ...state.filter(Boolean).map(s => h("span", { text: s }))),
      h("div", { class: "bar" }, h("div", { style: "width:" + pct + "%" }))));
  }
  renderPill();
}
// on a phone the sidebar is hidden: a pill above the + shows uploads in flight
function renderPill() {
  let p = $("pill");
  const active = transfers.filter(x => x.state === "running" || x.state === "queued");
  if (!active.length) { if (p) p.remove(); return; }
  if (!p) {
    p = h("button", { id: "pill", class: "toast", style: "bottom:calc(88px + var(--safe-b));border-color:var(--accent);cursor:pointer", onclick: openSide });
    $("browser").append(p);
  }
  const size = active.reduce((a, t) => a + t.size, 0), sent = active.reduce((a, t) => a + t.sent, 0);
  p.textContent = "↑ Uploading " + active.length + " file" + (active.length > 1 ? "s" : "") + " · " + (size ? Math.round(sent / size * 100) : 0) + "%";
  p.classList.toggle("only-narrow", true);
}
$("transfers-clear").onclick = () => {
  for (let i = transfers.length - 1; i >= 0; i--) if (["done", "canceled"].includes(transfers[i].state)) transfers.splice(i, 1);
  renderTransfers();
};
window.addEventListener("beforeunload", e => {
  if (transfers.some(t => t.state === "running" || t.state === "queued")) { e.preventDefault(); e.returnValue = ""; }
});

// Upload a list of {file, rel} into a folder: asks first when names are taken here.
async function uploadFiles(items, dir) {
  dir = dir || S.path;
  if (!items.length) return;
  if (!S.perms.upload) return toast("This server doesn't take uploads here", true);
  const here = new Set(dir === S.path ? S.entries.map(e => e.rel) : []);
  const clash = items.filter(it => here.has(it.rel.split("/")[0]));
  let todo = items;
  if (clash.length) {
    const one = clash.length === 1;
    const v = await dialog({
      title: one ? "Replace " + clash[0].rel + "?" : "Replace " + clash.length + " files?",
      text: (one ? "A file with this name already exists" : "Files with these names already exist") + " in " + dir + ". Uploading replaces " + (one ? "it" : "them") + " on the server.",
      buttons: [{ label: "Cancel", value: "" }, "|",
      items.length > clash.length && { label: "Skip existing", value: "skip" },
      { label: "Keep both", value: "both" },
      { label: "Replace", primary: true, value: "replace" }].filter(Boolean),
    });
    if (!v) return;
    if (v === "skip") todo = items.filter(it => !clash.includes(it));
    if (v === "both") todo = items.map(it => clash.includes(it) ? { file: it.file, rel: freeName(it.rel, here) } : it);
    if (v === "replace" && !S.perms.delete) toast("This server may refuse to replace files (no delete permission)", true);
  }
  todo.forEach(it => queueUpload(it.file, dir, it.rel));
  if (narrow() && todo.length) toast("Uploading " + (todo.length === 1 ? todo[0].rel : todo.length + " files") + " to " + dir);
}
function freeName(name, taken) {
  const dot = name.lastIndexOf("."), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; ; i++) { const n = stem + " (" + i + ")" + ext; if (!taken.has(n)) { taken.add(n); return n; } }
}
$("file-input").addEventListener("change", e => {
  const files = [...e.target.files]; e.target.value = "";
  uploadFiles(files.map(f => ({ file: f, rel: f.name })));
});
$("dir-input").addEventListener("change", e => {
  const files = [...e.target.files]; e.target.value = "";
  uploadFiles(files.map(f => ({ file: f, rel: f.webkitRelativePath || f.name })));
});
function pickFiles(capture) {
  const i = $("file-input");
  if (capture) { i.setAttribute("accept", "image/*,video/*"); i.setAttribute("capture", "environment"); }
  else { i.removeAttribute("accept"); i.removeAttribute("capture"); }
  i.click();
}
function uploadMenu(anchor) {
  openMenu([
    { label: "Upload files…", run: () => pickFiles(false) },
    { label: "Upload a folder…", run: () => $("dir-input").click() },
    narrow() && { label: "Take a photo or video…", run: () => pickFiles(true) },
    "-",
    { label: "New folder…", run: makeDir },
  ], anchor, "To " + S.path);
}

// drag & drop, folders included
(() => {
  const area = $("listarea"); let depth = 0;
  const has = e => [...(e.dataTransfer?.types || [])].includes("Files");
  area.addEventListener("dragenter", e => {
    if (!has(e)) return; e.preventDefault(); depth++;
    if (S.perms.upload && !S.query) { $("drop-text").textContent = "Drop to upload to " + S.path; $("drop").classList.remove("hidden"); }
  });
  area.addEventListener("dragover", e => { if (has(e)) { e.preventDefault(); e.dataTransfer.dropEffect = S.perms.upload ? "copy" : "none"; } });
  area.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; $("drop").classList.add("hidden"); } });
  area.addEventListener("drop", async e => {
    e.preventDefault(); depth = 0; $("drop").classList.add("hidden");
    if (!S.perms.upload || S.query) return;
    const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return uploadFiles([...e.dataTransfer.files].map(f => ({ file: f, rel: f.name })));
    const out = [];
    const walk = (ent, pre) => new Promise(res => {
      if (ent.isFile) ent.file(f => { out.push({ file: f, rel: pre + f.name }); res(); }, () => res());
      else if (ent.isDirectory) {
        const r = ent.createReader(), all = [];
        const more = () => r.readEntries(async batch => {
          if (batch.length) { all.push(...batch); more(); }
          else { for (const c of all) await walk(c, pre + ent.name + "/"); res(); }
        }, () => res());
        more();
      } else res();
    });
    for (const ent of entries) await walk(ent, "");
    uploadFiles(out);
  });
})();

// ── shared from another app (the service worker keeps them until they're uploaded) ─────────────
const SHARE_DB = "dufs-share";
function shareDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(SHARE_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("shares", { keyPath: "id" });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function shareOp(mode, fn) {
  const db = await shareDb();
  return new Promise((res, rej) => {
    const tx = db.transaction("shares", mode), st = tx.objectStore("shares");
    const r = fn(st);
    tx.oncomplete = () => { db.close(); res(r && r.result); }; tx.onerror = () => { db.close(); rej(tx.error); };
  });
}
let share = null;
async function takeShare(id) {
  try { share = await shareOp("readonly", st => st.get(id)); } catch { share = null; }
  if (!share) { toast("The shared files are gone (already uploaded or cleared)", true); return; }
  renderShare();
}
function shareNote() {
  const txt = [share.title, share.text, share.url].filter(Boolean);
  // a shared link often comes twice: as text and as url
  return [...new Set(txt)].join("\n") + "\n";
}
function renderShare() {
  const bar = $("share-bar");
  if (!share) { bar.classList.add("hidden"); return; }
  const files = share.files || [];
  const note = !files.length && (share.text || share.url);
  bar.replaceChildren(...[
    h("div", { style: "font-weight:700", text: files.length ? "Upload " + (files.length === 1 ? files[0].name : files.length + " shared files") : "Save the shared text as a note" }),
    h("div", { class: "faint small", text: "Into " + S.path + " — open another folder first to put it there." }),
    files.length > 1 ? h("div", { class: "sb-files", text: files.map(f => f.name + " (" + fmtSize(f.blob.size) + ")").join(", ") }) : null,
    h("div", { class: "sb-buttons" },
      h("button", { class: "btn", text: "Cancel", onclick: dropShare }),
      h("button", {
        class: "btn primary", text: files.length ? "Upload here" : "Save here", disabled: !S.perms.upload || !!S.query || !!S.error,
        onclick: async () => {
          const it = share; save("shareDir", S.path);
          if (files.length) await uploadFiles(files.map(f => ({ file: new File([f.blob], f.name || "shared", { type: f.type }), rel: f.name || "shared" })));
          else if (note) {
            const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "-");
            const name = ((it.title || "").replace(/[\/\\]/g, "-").trim() || "Shared") + " " + stamp + ".txt";
            await uploadFiles([{ file: new File([shareNote()], name, { type: "text/plain" }), rel: name }]);
          }
          dropShare();
        },
      }))].filter(Boolean));
  bar.classList.remove("hidden");
  $("fab").classList.add("hidden");
}
async function dropShare() {
  if (share) { const id = share.id; share = null; try { await shareOp("readwrite", st => st.delete(id)); } catch { } }
  renderShare(); renderToolbar();
}

// ── sidebar on a phone ─────────────────────────────────────────────────────────────────────────
function openSide() { document.body.classList.add("side-open"); }
function closeSide() { document.body.classList.remove("side-open"); }
$("menu-btn").onclick = openSide;
$("side-close").onclick = closeSide;
$("scrim").onclick = closeSide;

// ── toolbar buttons ────────────────────────────────────────────────────────────────────────────
$("pin-btn").onclick = () => togglePin(S.path);
$("goto-btn").onclick = startAddress;
$("view-btn").onclick = () => { S.grid = !S.grid; save("grid", S.grid); renderToolbar(); renderList(); };
$("mkdir-btn").onclick = makeDir;
$("upload-btn").onclick = e => uploadMenu(e.currentTarget);
$("refresh-btn").onclick = () => refresh();
$("fab").onclick = e => uploadMenu(e.currentTarget);
$("up-row").onclick = goUp;
$("more-btn").onclick = e => openMenu([
  S.perms.upload && !S.query && { label: "Upload files…", run: () => pickFiles(false) },
  S.perms.upload && !S.query && { label: "New folder…", run: makeDir },
  { label: S.grid ? "Show as a list" : "Show as a grid", run: () => $("view-btn").click() },
  { label: isPinned(S.path) ? "Unpin this folder" : "Pin this folder", run: () => togglePin(S.path) },
  { label: "Go to an address…", run: startAddress },
  { label: "Copy this folder's link", run: () => copyText(absUrl(S.path)) },
  S.perms.archive && { label: "Download folder as .zip", run: () => download({ dir: true, path: S.path, name: baseName(S.path) === "/" ? location.hostname : baseName(S.path) }) },
  { label: "Refresh", run: () => refresh() },
  S.auth && "-",
  S.auth && (S.user ? { label: "Log out (" + S.user + ")", run: logout } : { label: "Log in", run: login }),
], e.currentTarget);
document.querySelectorAll("#list-head button").forEach(b => b.onclick = () => {
  const k = b.dataset.sort;
  S.sort = S.sort.k === k ? { k, asc: !S.sort.asc } : { k, asc: k === "name" };
  save("sort", S.sort); renderList();
});

// keyboard: the Basecamp app's shortcuts, plus arrows
document.addEventListener("keydown", e => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "f" && S.perms.search) { e.preventDefault(); if (narrow()) document.body.classList.add("searching"); $("search").focus(); $("search").select(); return; }
  if (mod && e.key.toLowerCase() === "l") { e.preventDefault(); startAddress(); return; }
  if (mod && e.key.toLowerCase() === "s" && S.editing) { e.preventDefault(); saveEdit(); return; }
  if (e.key === "Escape") {
    if (!$("menu").classList.contains("hidden")) return closeMenu();
    if (dlgDone) return dlgDone(null);
    if (document.querySelector(".viewer")) return document.querySelector(".viewer").remove();
    if (S.editing) { S.editing = false; return renderPreview(); }
    if (S.sel && !typing) return closePreview();
  }
  if (typing || dlgDone || mod) return;
  const items = sorted(), i = items.findIndex(x => x.path === S.sel);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (n) { S.sel = n.path; renderList(); renderPreview(); document.querySelector(".sel")?.scrollIntoView({ block: "nearest" }); }
  } else if (e.key === "Enter" && i >= 0) activate(items[i]);
  else if (e.key === "Backspace") { e.preventDefault(); goUp(); }
  else if (e.key === "Delete" && i >= 0 && S.perms.delete) deletePath(items[i]);
});

// pull down at the top of the list to refresh (an installed app has no browser reload)
(() => {
  const list = $("list"); let y0 = -1;
  list.addEventListener("touchstart", e => { y0 = list.scrollTop <= 0 ? e.touches[0].clientY : -1; }, { passive: true });
  list.addEventListener("touchend", e => {
    if (y0 >= 0 && e.changedTouches[0].clientY - y0 > 90) refresh();
    y0 = -1;
  });
})();

// keep the listing fresh: when the app comes back, and every 15 s while it's on screen
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(true); });
setInterval(() => {
  if (document.hidden || S.loading || S.editing || dlgDone || !$("menu").classList.contains("hidden")) return;
  refresh(true);
}, 15000);

// ── installable app ────────────────────────────────────────────────────────────────────────────
let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("install").classList.remove("hidden"); });
$("install-btn").onclick = async () => {
  if (!installEvt) return;
  installEvt.prompt(); await installEvt.userChoice.catch(() => { });
  installEvt = null; $("install").classList.add("hidden");
};
window.addEventListener("appinstalled", () => $("install").classList.add("hidden"));
if ("serviceWorker" in navigator && window.isSecureContext) {
  // Its scope is the assets folder (no special header needed, so a stock dufs with --assets works):
  // it only has to catch the share target, which is posted to <assets>share-target.
  navigator.serviceWorker.register(ASSETS + "sw.js").catch(err => console.warn("Dufs: no service worker:", err));
} else if (!window.isSecureContext) {
  console.info("Dufs: installing as an app and sharing to Dufs need HTTPS");
}

// ── start ──────────────────────────────────────────────────────────────────────────────────────
(function start() {
  const params = new URLSearchParams(location.search);
  if (DATA.kind === "Edit" || DATA.kind === "View") {
    // a file opened with ?edit or ?view: its folder, with the file in the preview
    const file = DATA.href;
    S.auth = !!DATA.auth; S.user = DATA.user || null;
    history.replaceState(null, "", urlFor(parentOf(file)));
    go(parentOf(file), { push: false, sel: file, edit: DATA.kind === "Edit" && DATA.editable });
  } else {
    const path = isDirPath(DATA.href) ? DATA.href : DATA.href + "/";
    S.path = path;
    setEntries(DATA, path);
    S.sig = JSON.stringify(DATA.paths) + DATA.user + DATA.allow_upload;
    if (params.get("q")) S.query = params.get("q");
    $("search").value = S.query;
    history.replaceState({ path, sel: null }, "", location.href);
    render();
    if (!DATA.dir_exists && DATA.paths === undefined) S.error = "missing";
  }
  if (params.has("shared")) {
    const id = params.get("shared");
    const dir = load("shareDir", null);
    history.replaceState(history.state, "", location.pathname);
    // the folder used last time for shares, if it's somewhere else
    if (dir && dir !== S.path) go(dir).then(() => takeShare(id)); else takeShare(id);
  } else if (params.has("shared-error")) {
    toast("Couldn't receive the shared files: " + params.get("shared-error"), true);
    history.replaceState(history.state, "", location.pathname);
  }
})();
