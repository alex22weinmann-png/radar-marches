// Demain : les choses à faire demain, sans oublier et sans reporter.
// Données enregistrées sur l'appareil (localStorage).
// Rappels : ntfy programmé (appli fermée), notifications du navigateur (appli ouverte), export .ics.
"use strict";

const KEY = "demain.v1";
const PRIO = { 0: "Normal", 1: "Important", 2: "Urgent" };
const APP_URL = location.href.split("#")[0];

const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOffset = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const today = () => ymd(dayOffset(0));
const tomorrow = () => ymd(dayOffset(1));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const plural = (n, w) => `${n} ${w}${n > 1 ? "s" : ""}`;

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true && !k.startsWith("aria-") ? "" : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

/* ---------- Données ---------- */
function fresh() {
  return {
    tasks: [],
    sections: [{ id: uid(), name: "Cours" }, { id: uid(), name: "Projets perso" }],
    settings: { ntfyTopic: "", morning: { on: true, time: "07:30" }, evening: { on: true, time: "20:00" } },
    recaps: {},
  };
}
function load() {
  let s;
  try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (!s || !Array.isArray(s.tasks)) return fresh();
  const d = fresh();
  s.settings = Object.assign({}, d.settings, s.settings);
  s.recaps = s.recaps || {};
  s.sections = (s.sections || []).map(x => ({ id: x.id, name: x.name }));
  s.tasks.forEach(t => { if (t.priority > 2) t.priority = 2; });  // ancienne échelle 0-3
  return s;
}
const state = load();
let tab = null;
let filter = null;  // id de section affichée, ou null pour tout
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { toast("Impossible d'enregistrer sur cet appareil"); } }
const section = id => state.sections.find(s => s.id === id);

// Les tâches cochées des jours passés disparaissent. Celles qui ne sont pas faites restent, en retard.
function cleanup() {
  const t = today();
  const n = state.tasks.length;
  state.tasks = state.tasks.filter(x => !(x.done && x.date < t));
  for (const k of Object.keys(state.recaps)) if (k.slice(-10) < t && !state.recaps[k].ntfy) delete state.recaps[k];
  if (state.tasks.length !== n) save();
}

function at(date, time) {
  if (!time) return null;
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
}
const remindAt = t => at(t.date, t.remind);
const openOn = date => state.tasks.filter(x => !x.done && (x.date === date || (date === today() && x.date < date)));
const byPriority = (a, b) => b.priority - a.priority || (a.remind || "99").localeCompare(b.remind || "99") || a.created - b.created;

/* ---------- Récap du matin / bilan du soir ---------- */
// Chaque récap porte sur un jour précis ; on prévoit celui d'aujourd'hui s'il est encore à venir, sinon celui de demain.
function recapPlans() {
  const plans = [];
  for (const kind of ["morning", "evening"]) {
    const cfg = state.settings[kind];
    if (!cfg.on || !cfg.time) continue;
    for (const date of [today(), tomorrow()]) {
      const when = at(date, cfg.time);
      if (when < Date.now() + 15000) continue;
      const list = openOn(date).sort(byPriority);
      const titles = list.slice(0, 6).map(t => (t.priority === 2 ? "‼ " : "– ") + t.title).join("\n") + (list.length > 6 ? `\n… et ${list.length - 6} autre(s)` : "");
      plans.push({
        id: `${kind}-${date}`, when, kind,
        title: list.length ? (kind === "morning" ? `Aujourd'hui, tu dois : ${plural(list.length, "tâche")}` : `Il te reste ${plural(list.length, "tâche")}`) : "",
        message: titles,
        priority: list.some(t => t.priority === 2) ? 4 : 3,
      });
      break;
    }
  }
  return plans;
}

/* ---------- ntfy (arrive même appli fermée) ---------- */
async function ntfyDelete(n) {
  try { await fetch(`https://ntfy.sh/${encodeURIComponent(n.topic)}/${n.seq}`, { method: "DELETE" }); } catch (e) {}
}
// holder = objet qui garde la trace de la notification programmée ; msg = null pour annuler.
async function ntfyPlan(holder, baseId, msg) {
  const topic = state.settings.ntfyTopic;
  const key = topic && msg ? [topic, msg.when, msg.title, msg.message, msg.priority].join("|") : "";
  if ((holder.ntfy ? holder.ntfy.key : "") === key && !holder.ntfyPending) return;
  if (holder.ntfy) { const old = holder.ntfy; delete holder.ntfy; ntfyDelete(old); }
  holder.ntfyPending = false;
  if (key) {
    const seq = `${baseId}-${Date.now().toString(36)}`.replace(/[^-_A-Za-z0-9]/g, "").slice(0, 64);
    try {
      const r = await fetch("https://ntfy.sh/", {
        method: "POST",
        body: JSON.stringify({ topic, title: msg.title, message: msg.message, delay: String(Math.floor(msg.when / 1000)),
          sequence_id: seq, priority: msg.priority, tags: [msg.tag || "pushpin"], click: APP_URL }),
      });
      if (!r.ok) throw new Error(r.status);
      holder.ntfy = { topic, seq, key };
    } catch (e) { holder.ntfyPending = true; }
  }
  save();
}
function taskMsg(t) {
  const when = remindAt(t);
  if (t.done || !when || when < Date.now() + 15000) return null;
  const sec = section(t.section);
  return { when, title: (t.priority === 2 ? "‼ " : "") + t.title,
    message: [t.note, sec && sec.name, t.priority ? PRIO[t.priority] : ""].filter(Boolean).join(" · ") || "À faire maintenant",
    priority: t.priority === 2 ? 5 : t.priority === 1 ? 4 : 3, tag: "alarm_clock" };
}
let syncTimer = null;
function syncAll() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    await Promise.all(state.tasks.map(t => ntfyPlan(t, t.id, taskMsg(t))));
    const plans = recapPlans();
    const wanted = new Set(plans.map(p => p.id));
    for (const [id, holder] of Object.entries(state.recaps)) if (!wanted.has(id)) { await ntfyPlan(holder, id, null); delete state.recaps[id]; }
    for (const p of plans) {
      const holder = state.recaps[p.id] = state.recaps[p.id] || {};
      await ntfyPlan(holder, p.id, p.title ? p : null);
    }
    save();
    scheduleLocal();
  }, 400);
}

/* ---------- Notifications du navigateur (appli ouverte) ---------- */
let timers = [];
function scheduleLocal() {
  timers.forEach(clearTimeout);
  timers = [];
  const now = Date.now();
  const jobs = [];
  for (const t of state.tasks) {
    const m = taskMsg(t) || (!t.done && remindAt(t) && now - remindAt(t) < 30 * 60000 ? { when: remindAt(t), title: t.title, message: t.note || "À faire maintenant" } : null);
    if (m && !t.notified && !t.ntfy) jobs.push([m, () => { t.notified = true; save(); }]);
  }
  for (const p of recapPlans()) {
    const holder = state.recaps[p.id];
    if (p.title && !(holder && (holder.ntfy || holder.fired))) jobs.push([p, () => { state.recaps[p.id] = Object.assign(holder || {}, { fired: true }); save(); }]);
  }
  for (const [m, mark] of jobs) {
    const delay = Math.max(0, m.when - now);
    if (delay < 2 ** 31 - 1) timers.push(setTimeout(() => { mark(); notify(m.title, m.message); }, delay));
  }
}
async function notify(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) { reg.showNotification(title, { body, icon: "icons/icon-192.png", requireInteraction: true }); return; }
      new Notification(title, { body }); return;
    } catch (e) {}
  }
  toast(title);
}

function changed() { save(); render(); syncAll(); }

/* ---------- Affichage ---------- */
const check = () => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.innerHTML = '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>';
  return s;
};

function render() {
  const isT = tab === "tomorrow";
  const t0 = today();
  document.querySelectorAll("#days button").forEach(b => b.setAttribute("aria-current", b.dataset.day === tab));
  $("#date").textContent = (isT ? dayOffset(1) : dayOffset(0)).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });

  if (filter && !section(filter)) filter = null;
  const inFilter = x => !filter || x.section === filter;
  const all = state.tasks.filter(x => isT ? x.date === tomorrow() : (x.date === t0 || (x.date < t0 && !x.done)));
  const shown = all.filter(inFilter);
  const doneN = all.filter(x => x.done).length;

  const allDone = all.length && doneN === all.length;
  $("#title").textContent = (isT ? "Demain" : "Aujourd'hui") + (allDone ? ", c'est fait." : ", je dois");
  document.title = isT ? "Demain" : "Aujourd'hui";
  const score = $("#score");
  score.replaceChildren();
  if (all.length) score.append(h("b", {}, doneN), "/" + all.length);
  $("#bar").style.width = all.length ? (doneN / all.length * 100) + "%" : "0";

  // Filtres de section
  const fl = $("#filters");
  fl.replaceChildren();
  if (state.sections.length) {
    const used = new Set(all.map(x => x.section));
    fl.append(h("button", { type: "button", "aria-pressed": !filter, onclick: () => { filter = null; render(); } }, "Tout"),
      ...state.sections.filter(s => used.has(s.id) || filter === s.id).map(s =>
        h("button", { type: "button", "aria-pressed": filter === s.id, onclick: () => { filter = filter === s.id ? null : s.id; render(); } }, s.name)));
    if (fl.children.length < 2) fl.replaceChildren();
  }

  // Sur « Demain » : ce qui reste aujourd'hui doit être fait, pas reporté.
  const nudge = $("#nudge");
  nudge.replaceChildren();
  const left = openOn(t0).length;
  if (isT && left) nudge.append(h("div", { class: "nudge" },
    h("span", {}, `Il te reste ${plural(left, "tâche")} aujourd'hui.`),
    h("button", { type: "button", onclick: () => { tab = "today"; render(); } }, "Voir →")));

  const main = $("#list");
  main.replaceChildren();
  if (!shown.length) {
    main.append(h("div", { class: "empty" },
      h("b", {}, isT ? "Rien de prévu pour demain." : "Rien pour aujourd'hui."),
      isT ? "Note ici tout ce que tu dois faire demain." : "Prépare ta journée la veille, dans l'onglet Demain."));
    return;
  }
  const late = shown.filter(x => !x.done && x.date < t0).sort(byPriority);
  const open = shown.filter(x => !x.done && x.date >= t0).sort(byPriority);
  const done = shown.filter(x => x.done).sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0));
  let n = 0;
  if (late.length) {
    main.append(h("p", { class: "group-title hot" }, `En retard · ${late.length}`));
    late.forEach(t => main.append(row(t, ++n)));
    if (open.length) main.append(h("p", { class: "group-title" }, "Prévu aujourd'hui"));
  }
  open.forEach(t => main.append(row(t, ++n)));
  if (done.length) {
    main.append(h("p", { class: "group-title" }, `Fait · ${done.length}`));
    done.forEach(t => main.append(row(t, ++n)));
  }
}

function row(t, n) {
  const sec = section(t.section);
  const late = !t.done && t.date < today();
  const meta = [
    late ? h("span", { class: "late" }, "Pas fait " + (t.date === ymd(dayOffset(-1)) ? "hier" : "le " + new Date(t.date + "T12:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short" }))) : null,
    t.remind ? h("span", {}, "Rappel " + t.remind.replace(":", " h ")) : null,
    sec && !filter ? h("span", {}, sec.name) : null,
  ].filter(Boolean);
  const el = h("div", { class: `task p${t.priority}` + (t.done ? " done" : "") + (late ? " late" : ""), "data-id": t.id },
    h("span", { class: "num" }, pad(n)),
    h("div", { class: "t-main", onclick: () => openTask(t), role: "button", tabindex: 0,
      onkeydown: e => { if (e.key === "Enter") openTask(t); } },
      h("div", { class: "t-title" }, t.title),
      t.note ? h("div", { class: "t-note" }, t.note) : null,
      meta.length ? h("div", { class: "t-meta" }, meta) : null),
    t.priority ? h("span", { class: `tag p${t.priority}` }, PRIO[t.priority]) : h("span"),
    h("button", { class: "box", type: "button", "aria-pressed": t.done, "aria-label": (t.done ? "Décocher : " : "Fait : ") + t.title,
      onclick: () => toggle(t, el) }, check()));
  return el;
}

let toggleTimer = null;
function toggle(t, el) {
  t.done = !t.done;
  t.doneAt = t.done ? Date.now() : null;
  if (t.done && t.date < today()) t.date = today();  // une tâche en retard enfin faite compte pour aujourd'hui
  el.classList.toggle("done", t.done);
  save();
  syncAll();
  clearTimeout(toggleTimer);
  toggleTimer = setTimeout(render, t.done ? 500 : 0);
  if (t.done && openOn(today()).length === 0 && tab === "today") setTimeout(() => toast("Tout est fait pour aujourd'hui."), 550);
}

/* ---------- Ajout ---------- */
let addPrio = 0;
const pick = (sel, v) => document.querySelectorAll(sel + " button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === String(v)));
const addForm = $("#add");
const addInput = $("#add-input");
function resetAdd() { addInput.value = ""; addPrio = 0; pick("#add-prio", 0); $("#add-time").value = ""; addForm.classList.remove("open"); }
addInput.addEventListener("input", () => addForm.classList.toggle("open", addInput.value.trim() !== ""));
$("#add-prio").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { addPrio = +b.dataset.v; pick("#add-prio", addPrio); addInput.focus(); } });
addForm.addEventListener("submit", e => {
  e.preventDefault();
  const title = addInput.value.trim();
  if (!title) { addInput.focus(); return; }
  const t = { id: uid(), created: Date.now(), done: false, title, note: "", priority: addPrio, section: filter,
    date: tab === "tomorrow" ? tomorrow() : today(), remind: $("#add-time").value || null };
  state.tasks.push(t);
  resetAdd();
  addInput.focus();
  changed();
  if (t.remind && remindAt(t) < Date.now()) toast("L'heure du rappel est déjà passée");
  else if (t.remind && !state.settings.ntfyTopic) hintOnce();
  const el = document.querySelector(`[data-id="${t.id}"]`);
  if (el) el.classList.add("flash");
});
function hintOnce() {
  try { if (localStorage.getItem("demain.hinted")) return; localStorage.setItem("demain.hinted", "1"); } catch (e) {}
  toast("Pour recevoir les rappels appli fermée, configure ntfy dans Réglages");
}

/* ---------- Modifier une tâche ---------- */
let editing = null, form = {};
function renderSecPick() {
  $("#f-section-wrap").hidden = !state.sections.length;
  $("#f-section").replaceChildren(
    h("button", { type: "button", "aria-pressed": !form.section, onclick: () => { form.section = null; renderSecPick(); } }, "Aucune"),
    ...state.sections.map(s => h("button", { type: "button", "aria-pressed": form.section === s.id, onclick: () => { form.section = s.id; renderSecPick(); } }, s.name)));
}
function openTask(t) {
  editing = t;
  form = { priority: t.priority, section: section(t.section) ? t.section : null };
  const f = $("#task-form");
  f.elements.title.value = t.title;
  f.elements.note.value = t.note || "";
  f.elements.remind.value = t.remind || "";
  pick("#f-prio", form.priority);
  renderSecPick();
  openPanel("#task-panel");
}
$("#f-prio").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { form.priority = +b.dataset.v; pick("#f-prio", form.priority); } });
$("#clear-remind").addEventListener("click", () => { $("#task-form").elements.remind.value = ""; });
$("#task-form").addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target.elements;
  const title = f.title.value.trim();
  if (!title) { f.title.focus(); return; }
  const remind = f.remind.value || null;
  if (remind !== editing.remind) editing.notified = false;
  Object.assign(editing, { title, note: f.note.value.trim(), priority: form.priority, section: form.section, remind });
  closePanel("#task-panel");
  changed();
  if (remind && remindAt(editing) < Date.now()) toast("L'heure du rappel est déjà passée");
});
$("#delete-task").addEventListener("click", () => {
  if (!editing || !confirm(`Supprimer « ${editing.title} » ?`)) return;
  const t = editing;
  if (t.ntfy) ntfyDelete(t.ntfy);
  state.tasks = state.tasks.filter(x => x !== t);
  closePanel("#task-panel");
  changed();
});

/* ---------- Panneaux ---------- */
function openPanel(sel) { $(sel).hidden = false; document.body.style.overflow = "hidden"; }
function closePanel(sel) { $(sel).hidden = true; if (!document.querySelector(".panel-wrap:not([hidden])")) document.body.style.overflow = ""; }
document.querySelectorAll(".panel-wrap").forEach(w => w.addEventListener("click", e => {
  if (e.target.closest("[data-close]")) { closePanel("#" + w.id); render(); }
}));
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { document.querySelectorAll(".panel-wrap:not([hidden])").forEach(w => closePanel("#" + w.id)); render(); }
  if (e.key === "n" && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA/.test(document.activeElement.tagName) && !document.querySelector(".panel-wrap:not([hidden])")) {
    e.preventDefault(); addInput.focus();
  }
});

/* ---------- Réglages ---------- */
function renderSections() {
  const box = $("#sections-list");
  box.replaceChildren(...state.sections.map(s => {
    const n = state.tasks.filter(x => x.section === s.id && !x.done).length;
    return h("div", { class: "sec-row" },
      h("input", { value: s.name, maxlength: 24, "aria-label": "Nom de la section",
        onchange: e => { const v = e.target.value.trim(); if (v) { s.name = v; save(); } else e.target.value = s.name; } }),
      n ? h("span", { class: "n" }, plural(n, "tâche")) : null,
      h("button", { type: "button", class: "txt danger", onclick: () => {
        if (!confirm(n ? `Supprimer « ${s.name} » ? Ses tâches sont gardées, sans section.` : `Supprimer « ${s.name} » ?`)) return;
        state.sections = state.sections.filter(x => x !== s);
        state.tasks.forEach(x => { if (x.section === s.id) x.section = null; });
        save(); renderSections();
      } }, "Supprimer"));
  }));
}
$("#add-section").addEventListener("submit", e => {
  e.preventDefault();
  const input = e.target.elements.secname;
  const name = input.value.trim();
  if (!name) return;
  state.sections.push({ id: uid(), name });
  input.value = "";
  save(); renderSections();
});
for (const kind of ["morning", "evening"]) {
  $(`#${kind}-on`).addEventListener("change", e => { state.settings[kind].on = e.target.checked; save(); syncAll(); });
  $(`#${kind}-time`).addEventListener("change", e => { if (e.target.value) { state.settings[kind].time = e.target.value; save(); syncAll(); } });
}
function renderNotifBtn() {
  const b = $("#ask-notif");
  if (!("Notification" in window)) { b.hidden = true; return; }
  const p = Notification.permission;
  b.textContent = p === "granted" ? "Notifications du navigateur : activées" : p === "denied" ? "Notifications du navigateur : bloquées" : "Activer les notifications du navigateur";
  b.disabled = p !== "default";
}
$("#ask-notif").addEventListener("click", async () => { await Notification.requestPermission(); renderNotifBtn(); scheduleLocal(); });
$("#ntfy-topic").addEventListener("change", e => {
  const v = e.target.value.trim().replace(/[^-_A-Za-z0-9]/g, "");
  e.target.value = v;
  state.settings.ntfyTopic = v;
  save(); syncAll();
  if (v) toast("Rappels ntfy activés");
});
$("#ntfy-test").addEventListener("click", async () => {
  const topic = state.settings.ntfyTopic;
  if (!topic) { toast("Indique d'abord un sujet ntfy"); $("#ntfy-topic").focus(); return; }
  try {
    const r = await fetch("https://ntfy.sh/", { method: "POST", body: JSON.stringify({ topic, title: "Demain", message: "Les rappels fonctionnent.", tags: ["white_check_mark"], click: APP_URL }) });
    toast(r.ok ? "Test envoyé" : "ntfy a refusé l'envoi (" + r.status + ")");
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
$("#open-settings").addEventListener("click", () => {
  renderSections();
  renderNotifBtn();
  for (const kind of ["morning", "evening"]) {
    $(`#${kind}-on`).checked = state.settings[kind].on;
    $(`#${kind}-time`).value = state.settings[kind].time;
  }
  $("#ntfy-topic").value = state.settings.ntfyTopic || "";
  openPanel("#settings-panel");
});

/* ---------- Navigation ---------- */
$("#days").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { tab = b.dataset.day; filter = null; resetAdd(); render(); } });

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

/* ---------- Démarrage ---------- */
// La journée s'ouvre sur ce qu'il reste à faire ; à partir de 18 h, sur la liste du lendemain.
const defaultTab = () => (openOn(today()).length && new Date().getHours() < 18) || new Date().getHours() < 12 ? "today" : "tomorrow";
let lastDay = today();
function refresh() {
  if (today() !== lastDay) { lastDay = today(); tab = defaultTab(); }
  cleanup(); render(); syncAll();
}
tab = defaultTab();
pick("#add-prio", 0);
cleanup();
render();
syncAll();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
window.addEventListener("online", syncAll);
window.addEventListener("storage", e => { if (e.key === KEY) { Object.assign(state, load()); render(); scheduleLocal(); } });
setInterval(() => { if (today() !== lastDay) refresh(); }, 60000);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
