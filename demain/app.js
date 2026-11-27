// Demain : les choses à faire demain, avec priorités, sections et rappels.
// Données enregistrées sur l'appareil (localStorage). Rappels : notifications locales + ntfy (programmées).
"use strict";

const KEY = "demain.v1";
const COLORS = ["#007AFF", "#34C759", "#FF9500", "#FF3B30", "#AF52DE", "#FF2D55", "#5AC8FA", "#A2845E"];
const PRIO = { 3: "Haute", 2: "Moyenne", 1: "Basse", 0: "Sans priorité" };
const MARKS = { 3: "!!!", 2: "!!", 1: "!", 0: "" };
const APP_URL = location.href.split("#")[0];

const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOffset = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const today = () => ymd(dayOffset(0));
const tomorrow = () => ymd(dayOffset(1));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") for (const [p, x] of Object.entries(v)) el.style.setProperty(p, x);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

/* ---------- Données ---------- */
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && Array.isArray(s.tasks)) return s;
  } catch (e) {}
  return {
    tasks: [],
    sections: [
      { id: uid(), name: "Cours", color: COLORS[0] },
      { id: uid(), name: "Projets perso", color: COLORS[4] },
    ],
    settings: { view: "priority", defaultTime: "08:00", ntfyTopic: "", showDone: true },
  };
}
const state = load();
let tab = null;
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { toast("Impossible d'enregistrer sur cet appareil"); } }
const section = id => state.sections.find(s => s.id === id);

// Nettoyage quotidien : on oublie les tâches terminées des jours passés.
function cleanup() {
  const t = today();
  const before = state.tasks.length;
  state.tasks = state.tasks.filter(x => !(x.done && x.date < t));
  if (state.tasks.length !== before) save();
}

function remindAt(task) {
  if (!task.remind) return null;
  const [y, m, d] = task.date.split("-").map(Number);
  const [hh, mm] = task.remind.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
}

/* ---------- Rappels ntfy (arrivent même appli fermée) ---------- */
function ntfyKey(task) {
  const at = remindAt(task);
  if (!state.settings.ntfyTopic || task.done || !at || at < Date.now() + 15000) return "";
  return [state.settings.ntfyTopic, at, task.title, task.note || "", task.priority].join("|");
}
async function ntfyCancel(task) {
  const n = task.ntfy;
  if (!n) return;
  delete task.ntfy;
  try { await fetch(`https://ntfy.sh/${encodeURIComponent(n.topic)}/${n.seq}`, { method: "DELETE" }); } catch (e) {}
}
async function ntfySync(task) {
  const key = ntfyKey(task);
  if ((task.ntfy && task.ntfy.key) === key && !task.ntfyPending) return;
  await ntfyCancel(task);
  task.ntfyPending = false;
  if (key) {
    const seq = `${task.id}-${Date.now().toString(36)}`;
    const sec = section(task.section);
    try {
      const r = await fetch("https://ntfy.sh/", {
        method: "POST",
        body: JSON.stringify({
          topic: state.settings.ntfyTopic,
          title: (MARKS[task.priority] ? MARKS[task.priority] + " " : "") + task.title,
          message: [task.note, sec && sec.name].filter(Boolean).join(" · ") || "Rappel de ta liste Demain",
          delay: String(Math.floor(remindAt(task) / 1000)),
          sequence_id: seq,
          priority: task.priority === 3 ? 4 : 3,
          tags: ["alarm_clock"],
          click: APP_URL,
        }),
      });
      if (!r.ok) throw new Error(r.status);
      task.ntfy = { topic: state.settings.ntfyTopic, seq, key };
    } catch (e) {
      task.ntfyPending = true;
    }
  }
  save();
}
const ntfySyncAll = () => Promise.all(state.tasks.map(ntfySync));

/* ---------- Rappels locaux (appli ouverte) ---------- */
let timers = [];
function scheduleLocal() {
  timers.forEach(clearTimeout);
  timers = [];
  const now = Date.now();
  for (const t of state.tasks) {
    const at = remindAt(t);
    if (!at || t.done || t.notified) continue;
    if (at <= now) {
      if (now - at < 30 * 60 * 1000) fire(t);  // rappel manqué il y a moins de 30 min
      continue;
    }
    if (at - now < 2 ** 31 - 1) timers.push(setTimeout(() => fire(t), at - now));
  }
}
async function fire(task) {
  if (task.done || task.notified) return;
  task.notified = true;
  save();
  const body = [task.note, section(task.section) && section(task.section).name].filter(Boolean).join(" · ");
  // Si ntfy est configuré, il s'en charge déjà ; on évite la double notification.
  if (task.ntfy) { if (document.visibilityState === "visible") toast("⏰ " + task.title); return; }
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) reg.showNotification(task.title, { body: body || "Rappel", tag: task.id, icon: "icons/icon-192.png", badge: "icons/icon-192.png" });
      else new Notification(task.title, { body: body || "Rappel", tag: task.id });
      return;
    } catch (e) {}
  }
  toast("⏰ " + task.title);
}

function afterChange(task) {
  save();
  render();
  if (task) ntfySync(task);
}

/* ---------- Affichage ---------- */
function visibleTasks() {
  const t = today();
  if (tab === "tomorrow") return state.tasks.filter(x => x.date === tomorrow());
  return state.tasks.filter(x => x.date === t || (x.date < t && !x.done));
}
const sortTasks = list => list.sort((a, b) =>
  b.priority - a.priority || (a.remind || "99").localeCompare(b.remind || "99") || a.created - b.created);

function render() {
  const d = tab === "tomorrow" ? dayOffset(1) : dayOffset(0);
  $("#title").textContent = tab === "tomorrow" ? "Demain" : "Aujourd'hui";
  $("#subtitle").textContent = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  document.title = tab === "tomorrow" ? "Demain" : "Aujourd'hui";
  document.querySelectorAll("#day-seg button").forEach(b => b.setAttribute("aria-selected", b.dataset.day === tab));
  document.querySelectorAll("#view-seg button").forEach(b => b.setAttribute("aria-selected", b.dataset.view === state.settings.view));
  $("#view-seg").hidden = state.sections.length === 0;

  const list = visibleTasks();
  const open = sortTasks(list.filter(x => !x.done));
  const done = list.filter(x => x.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  $("#count").textContent = list.length ? (open.length ? `${open.length} à faire` : "Tout est fait") : "";

  renderBanner();

  const main = $("#list");
  main.replaceChildren();
  if (!list.length) {
    main.append(h("div", { class: "empty" },
      h("b", {}, tab === "tomorrow" ? "Rien de prévu pour demain" : "Rien pour aujourd'hui"),
      tab === "tomorrow" ? "Ajoute ce que tu dois faire demain dans le champ en bas." : "Les tâches que tu prépares la veille arrivent ici le lendemain."));
    return;
  }

  const groups = [];
  if (state.settings.view === "section" && state.sections.length) {
    for (const s of state.sections) groups.push({ name: s.name, color: s.color, items: open.filter(x => x.section === s.id) });
    groups.push({ name: "Sans section", items: open.filter(x => !section(x.section)) });
  } else {
    for (const p of [3, 2, 1, 0]) groups.push({ name: PRIO[p], prio: p, items: open.filter(x => x.priority === p) });
  }
  for (const g of groups) {
    if (!g.items.length) continue;
    main.append(h("section", { class: "section" },
      h("div", { class: "section-head" },
        g.color ? h("span", { class: "tag", style: { background: g.color } }) : null,
        g.prio ? h("span", { class: `prio p${g.prio}` }, MARKS[g.prio]) : null,
        g.name, h("span", { class: "n" }, g.items.length)),
      h("div", { class: "card" }, g.items.map(taskRow))));
  }
  if (done.length) {
    const show = state.settings.showDone;
    main.append(h("section", { class: "section" },
      h("div", { class: "section-head" }, "Terminées",
        h("button", { class: "toggle", type: "button", onclick: () => { state.settings.showDone = !show; save(); render(); } },
          show ? "Masquer" : `Afficher (${done.length})`)),
      show ? h("div", { class: "card" }, done.map(taskRow)) : null));
  }
}

const bell = () => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.innerHTML = '<circle cx="12" cy="13" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 9v4l2.5 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
  return s;
};

function taskRow(t) {
  const sec = section(t.section);
  const late = !t.done && t.date < today();
  const showSec = sec && state.settings.view !== "section";
  const row = h("div", { class: "task" + (t.done ? " done" : ""), style: sec ? { "--ring": sec.color } : null },
    h("button", { class: "check", type: "button", "aria-label": (t.done ? "Rouvrir : " : "Terminer : ") + t.title, onclick: () => toggle(t, row) }),
    h("div", { class: "body", onclick: () => openTask(t) },
      h("div", { class: "t-title" }, t.title),
      t.note ? h("div", { class: "t-note" }, t.note) : null,
      (t.remind || late || showSec) ? h("div", { class: "meta" },
        late ? h("span", { class: "late" }, "En retard") : null,
        t.remind ? h("span", {}, bell(), t.remind.replace(":", " h ")) : null,
        showSec ? h("span", { class: "sec", style: { "--c": sec.color } }, h("i"), sec.name) : null) : null),
    t.priority ? h("span", { class: `prio p${t.priority}`, "aria-label": "Priorité " + PRIO[t.priority].toLowerCase() }, MARKS[t.priority]) : null);
  return row;
}

let toggleTimer = null;
function toggle(t, row) {
  t.done = !t.done;
  t.doneAt = t.done ? Date.now() : null;
  row.classList.toggle("done", t.done);
  save();
  ntfySync(t);
  scheduleLocal();
  clearTimeout(toggleTimer);
  toggleTimer = setTimeout(render, t.done ? 650 : 0);  // laisse voir la coche avant de ranger la tâche
}

function renderBanner() {
  const b = $("#banner");
  b.replaceChildren();
  const t = today();
  const pending = tab === "tomorrow"
    ? state.tasks.filter(x => !x.done && x.date <= t)
    : state.tasks.filter(x => !x.done && x.date < t);
  if (!pending.length || (tab === "tomorrow" && new Date().getHours() < 16)) return;
  const n = pending.length;
  b.append(h("div", { class: "banner" },
    h("span", {}, tab === "tomorrow"
      ? `${n} tâche${n > 1 ? "s" : ""} pas encore faite${n > 1 ? "s" : ""} aujourd'hui.`
      : `${n} tâche${n > 1 ? "s" : ""} en retard.`),
    h("button", { class: "link strong", type: "button", onclick: () => moveToTomorrow(pending) }, "Reporter à demain")));
}
function moveToTomorrow(list) {
  const d = tomorrow();
  list.forEach(x => { x.date = d; x.notified = false; ntfySync(x); });
  save(); render(); scheduleLocal();
  toast(list.length > 1 ? `${list.length} tâches reportées à demain` : "Tâche reportée à demain");
}

/* ---------- Fiche tâche ---------- */
let editing = null;   // tâche modifiée, ou null pour une nouvelle
let form = {};

function segPick(sel, value) {
  document.querySelectorAll(sel + " button").forEach(b => b.setAttribute("aria-selected", b.dataset.v === String(value)));
}
function renderChips() {
  const box = $("#f-section");
  box.replaceChildren(
    h("button", { type: "button", class: "chip", "aria-pressed": !form.section, onclick: () => { form.section = null; renderChips(); } }, "Aucune"),
    ...state.sections.map(s => h("button", { type: "button", class: "chip", style: { "--c": s.color }, "aria-pressed": form.section === s.id,
      onclick: () => { form.section = s.id; renderChips(); } }, h("i"), s.name)),
    h("button", { type: "button", class: "chip", onclick: () => { closeSheet("#task-sheet"); openSettings(); } }, "Gérer…"));
}

function openTask(task, presetTitle) {
  editing = task || null;
  const f = $("#task-form");
  form = {
    day: task ? (task.date <= today() ? "today" : "tomorrow") : tab,
    priority: task ? task.priority : 0,
    section: task ? (section(task.section) ? task.section : null) : null,
  };
  f.title.value = task ? task.title : (presetTitle || "");
  f.note.value = task ? (task.note || "") : "";
  f.hasRemind.checked = !!(task && task.remind);
  f.remind.value = (task && task.remind) || state.settings.defaultTime || "08:00";
  $("#remind-row").hidden = !f.hasRemind.checked;
  $("#task-sheet-title").textContent = task ? "Modifier" : "Nouvelle tâche";
  $("#delete-task").hidden = !task;
  segPick("#f-day", form.day);
  segPick("#f-prio", form.priority);
  renderChips();
  openSheet("#task-sheet");
  if (!task) setTimeout(() => f.title.focus(), 60);
}

$("#f-day").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { form.day = b.dataset.v; segPick("#f-day", form.day); } });
$("#f-prio").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { form.priority = +b.dataset.v; segPick("#f-prio", form.priority); } });
$("#task-form").hasRemind.addEventListener("change", e => { $("#remind-row").hidden = !e.target.checked; });

$("#task-form").addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target;
  const title = f.title.value.trim();
  if (!title) { f.title.focus(); return; }
  const t = editing || { id: uid(), created: Date.now(), done: false };
  const newDate = form.day === "today" ? (editing && editing.date < today() ? editing.date : today()) : tomorrow();
  const newRemind = f.hasRemind.checked ? f.remind.value || null : null;
  if (t.date !== newDate || t.remind !== newRemind) t.notified = false;
  Object.assign(t, { title, note: f.note.value.trim(), priority: form.priority, section: form.section, date: newDate, remind: newRemind });
  if (!editing) state.tasks.push(t);
  closeSheet("#task-sheet");
  afterChange(t);
  scheduleLocal();
  const at = remindAt(t);
  if (at && at < Date.now()) toast("Attention : l'heure du rappel est déjà passée");
  else if (at && !state.settings.ntfyTopic && !("Notification" in window && Notification.permission === "granted") && !localStorage.getItem("demain.hinted")) {
    try { localStorage.setItem("demain.hinted", "1"); } catch (e) {}
    toast("Active les rappels dans Réglages pour être prévenu");
  }
});

$("#delete-task").addEventListener("click", () => {
  if (!editing || !confirm(`Supprimer « ${editing.title} » ?`)) return;
  const t = editing;
  ntfyCancel(t);
  state.tasks = state.tasks.filter(x => x !== t);
  closeSheet("#task-sheet");
  save(); render(); scheduleLocal();
});

/* ---------- Saisie rapide ---------- */
$("#quick").addEventListener("submit", e => {
  e.preventDefault();
  const input = $("#quick-input");
  const title = input.value.trim();
  if (!title) return;
  const t = { id: uid(), created: Date.now(), done: false, title, note: "", priority: 0, section: null, date: tab === "tomorrow" ? tomorrow() : today(), remind: null };
  state.tasks.push(t);
  input.value = "";
  afterChange(t);
});
$("#quick-more").addEventListener("click", () => { const v = $("#quick-input").value.trim(); $("#quick-input").value = ""; openTask(null, v); });

/* ---------- Fiches ---------- */
function openSheet(sel) { $(sel).hidden = false; document.body.style.overflow = "hidden"; }
function closeSheet(sel) { $(sel).hidden = true; if (document.querySelectorAll(".sheet-wrap:not([hidden])").length === 0) document.body.style.overflow = ""; }
document.querySelectorAll(".sheet-wrap").forEach(w => w.addEventListener("click", e => {
  if (e.target.closest("[data-close]")) { closeSheet("#" + w.id); if (w.id === "settings-sheet") render(); }
}));
document.addEventListener("keydown", e => {
  if (e.key === "Escape") document.querySelectorAll(".sheet-wrap:not([hidden])").forEach(w => { closeSheet("#" + w.id); render(); });
  if (e.key === "n" && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA/.test(document.activeElement.tagName) && !document.querySelector(".sheet-wrap:not([hidden])")) {
    e.preventDefault(); $("#quick-input").focus();
  }
});

/* ---------- Réglages ---------- */
let paletteFor = null;
function renderSections() {
  const box = $("#sections-list");
  box.replaceChildren();
  if (!state.sections.length) { box.append(h("div", { class: "empty-sec" }, "Aucune section. Tes tâches sont rangées par priorité.")); return; }
  for (const s of state.sections) {
    box.append(h("div", { class: "sec-row" },
      h("button", { type: "button", class: "dot", style: { "--c": s.color }, "aria-label": "Couleur de " + s.name,
        onclick: () => { paletteFor = paletteFor === s.id ? null : s.id; renderSections(); } }),
      h("input", { value: s.name, maxlength: 30, "aria-label": "Nom de la section",
        onchange: e => { const v = e.target.value.trim(); if (v) { s.name = v; save(); } else e.target.value = s.name; } }),
      h("button", { type: "button", class: "del", onclick: () => {
        const n = state.tasks.filter(x => x.section === s.id).length;
        if (!confirm(n ? `Supprimer « ${s.name} » ? Ses ${n} tâche(s) seront gardées, sans section.` : `Supprimer « ${s.name} » ?`)) return;
        state.sections = state.sections.filter(x => x !== s);
        state.tasks.forEach(x => { if (x.section === s.id) x.section = null; });
        if (!state.sections.length) state.settings.view = "priority";
        save(); renderSections();
      } }, "Supprimer")));
    if (paletteFor === s.id) box.append(h("div", { class: "palette" }, COLORS.map(c =>
      h("button", { type: "button", style: { "--c": c }, "aria-label": "Choisir cette couleur", "aria-pressed": s.color === c,
        onclick: () => { s.color = c; paletteFor = null; save(); renderSections(); } }))));
  }
}
$("#add-section").addEventListener("submit", e => {
  e.preventDefault();
  const name = e.target.name.value.trim();
  if (!name) return;
  const used = state.sections.map(s => s.color);
  state.sections.push({ id: uid(), name, color: COLORS.find(c => !used.includes(c)) || COLORS[state.sections.length % COLORS.length] });
  e.target.name.value = "";
  save(); renderSections();
});

function renderNotifBtn() {
  const b = $("#ask-notif");
  if (!("Notification" in window)) { b.textContent = "Non disponible"; b.disabled = true; return; }
  const p = Notification.permission;
  b.textContent = p === "granted" ? "Activées" : p === "denied" ? "Bloquées" : "Activer";
  b.disabled = p !== "default";
}
$("#ask-notif").addEventListener("click", async () => { await Notification.requestPermission(); renderNotifBtn(); });
$("#default-time").addEventListener("change", e => { state.settings.defaultTime = e.target.value || "08:00"; save(); });
$("#ntfy-topic").addEventListener("change", async e => {
  const v = e.target.value.trim().replace(/[^-_A-Za-z0-9]/g, "");
  e.target.value = v;
  state.settings.ntfyTopic = v;
  save();
  await ntfySyncAll();
  if (v) toast("Rappels ntfy activés");
});
$("#ntfy-test").addEventListener("click", async () => {
  const topic = state.settings.ntfyTopic;
  if (!topic) { toast("Indique d'abord un sujet ntfy"); $("#ntfy-topic").focus(); return; }
  try {
    const r = await fetch("https://ntfy.sh/", { method: "POST", body: JSON.stringify({ topic, title: "Demain", message: "Les rappels fonctionnent ✓", tags: ["white_check_mark"], click: APP_URL }) });
    toast(r.ok ? "Notification de test envoyée" : "ntfy a refusé l'envoi (" + r.status + ")");
  } catch (e) { toast("Pas de connexion à ntfy.sh"); }
});

$("#export-ics").addEventListener("click", () => {
  const items = state.tasks.filter(t => !t.done && t.remind && t.date === tomorrow());
  if (!items.length) { toast("Aucune tâche de demain n'a de rappel"); return; }
  const stamp = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
  const esc = s => String(s).replace(/[\\;,]/g, m => "\\" + m).replace(/\n/g, "\\n");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Demain//FR", "CALSCALE:GREGORIAN"];
  for (const t of items) {
    const start = new Date(remindAt(t));
    lines.push("BEGIN:VEVENT", `UID:${t.id}@demain`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(new Date(start.getTime() + 15 * 60000))}`, `SUMMARY:${esc(t.title)}`);
    if (t.note) lines.push(`DESCRIPTION:${esc(t.note)}`);
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(t.title)}`, "TRIGGER:PT0M", "END:VALARM", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  const a = h("a", { href: URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/calendar" })), download: `rappels-${tomorrow()}.ics` });
  document.body.append(a); a.click(); a.remove();
});

function openSettings() {
  paletteFor = null;
  renderSections();
  renderNotifBtn();
  $("#default-time").value = state.settings.defaultTime || "08:00";
  $("#ntfy-topic").value = state.settings.ntfyTopic || "";
  openSheet("#settings-sheet");
}
$("#open-settings").addEventListener("click", openSettings);

/* ---------- Navigation ---------- */
$("#day-seg").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { tab = b.dataset.day; render(); } });
$("#view-seg").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { state.settings.view = b.dataset.view; save(); render(); } });

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

/* ---------- Démarrage ---------- */
// Le matin, on ouvre sur la liste du jour ; à partir de 16 h, sur celle du lendemain.
function defaultTab() {
  const openToday = state.tasks.some(x => !x.done && x.date <= today());
  return new Date().getHours() < 16 && openToday ? "today" : "tomorrow";
}
let lastDay = today();
function refresh() {
  if (today() !== lastDay) { lastDay = today(); tab = defaultTab(); }
  cleanup(); render(); scheduleLocal(); ntfySyncAll();
}
tab = defaultTab();
cleanup();
render();
scheduleLocal();
ntfySyncAll();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
window.addEventListener("online", ntfySyncAll);
window.addEventListener("storage", e => { if (e.key === KEY) { Object.assign(state, load()); render(); scheduleLocal(); } });
setInterval(() => { if (today() !== lastDay) refresh(); }, 60000);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
