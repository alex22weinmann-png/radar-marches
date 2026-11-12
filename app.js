"use strict";
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.setAttribute("style", v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};
const fmt = (n, d = 2) => n == null || isNaN(n) ? "–" : Number(n).toLocaleString("fr-CH", { minimumFractionDigits: d, maximumFractionDigits: d });
const sgn = (n, d = 2) => n == null || isNaN(n) ? "–" : (n > 0 ? "+" : n < 0 ? "−" : "") + fmt(Math.abs(n), d) + " %";
const cls = n => n == null ? "" : n > 0.05 ? "up" : n < -0.05 ? "down" : "flat";
const TYPES = { rapport: "Rapport", urgent: "Urgent", chute: "Chute", opportunite: "Opportunité", actu: "Actualité" };
const tz = { timeZone: "Europe/Zurich" };
const CLAUDE_APP = "https://claude.ai/artifact/Ns3bmX6ZPydsTTebkDTHuk";
const MARKET_ORDER = ["VWRL.SW", "^GSPC", "^IXIC", "^DJI", "^STOXX50E", "^SSMI", "^N225", "000001.SS", "^VIX", "^TNX", "CL=F", "GC=F", "CHF=X", "EURCHF=X", "BTC-USD"];

function when(iso) {
  if (!iso) return "";
  const d = new Date(iso), now = new Date();
  const mins = Math.round((now - d) / 60000);
  if (mins >= 0 && mins < 60) return mins <= 1 ? "à l'instant" : `il y a ${mins} min`;
  const same = d.toLocaleDateString("fr-CH", tz) === now.toLocaleDateString("fr-CH", tz);
  const t = d.toLocaleTimeString("fr-CH", { ...tz, hour: "2-digit", minute: "2-digit" });
  return same ? "aujourd'hui " + t : d.toLocaleDateString("fr-CH", { ...tz, day: "numeric", month: "short" }) + " " + t;
}
const timeParts = iso => { const d = new Date(iso); return [d.toLocaleDateString("fr-CH", { ...tz, day: "2-digit", month: "short" }), d.toLocaleTimeString("fr-CH", { ...tz, hour: "2-digit", minute: "2-digit" })]; };

// ---------------------------------------------------------------- données
const state = { index: null, live: null, articles: {}, filter: store.get("rm-filter", "tout"), error: false };
const params = new URLSearchParams(location.search);
if (params.get("t")) { store.set("rm-topic", params.get("t").replace(/[^A-Za-z0-9_-]/g, "")); history.replaceState(null, "", location.pathname + location.hash); }

async function getJSON(url) {
  const r = await fetch(url + (url.includes("?") ? "&" : "?") + "v=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
async function load() {
  try {
    const [index, live] = await Promise.all([getJSON("data/index.json"), getJSON("data/live.json").catch(() => null)]);
    state.index = index; state.live = live; state.error = false;
  } catch (e) { state.error = true; }
  render();
}
async function loadArticle(id) {
  if (state.articles[id]) return state.articles[id];
  try { state.articles[id] = await getJSON(`data/articles/${encodeURIComponent(id)}.json`); }
  catch (e) { state.articles[id] = null; }
  return state.articles[id];
}

// ---------------------------------------------------------------- composants
function renderEditions() {
  const hours = [8, 13, 18, 23];
  const nowH = Number(new Date().toLocaleString("en-GB", { ...tz, hour: "2-digit", hour12: false }));
  const next = hours.find(x => x > nowH) ?? 8;
  $("#editions").replaceChildren(...hours.map(x => h("span", { class: "ed" + (x === next ? " next" : ""), title: x === next ? "Prochain rapport" : "" }, String(x).padStart(2, "0") + ":00")));
}
function renderTape() {
  const m = state.live && state.live.marches;
  const tape = $("#tape");
  if (!m) { tape.replaceChildren(h("span", { class: "muted", style: "font-size:13px" }, state.error ? "Cotations indisponibles hors connexion." : "Chargement des cotations…")); return; }
  tape.replaceChildren(...MARKET_ORDER.filter(s => m[s] && !m[s].error).map(s => {
    const x = m[s];
    return h("div", { class: "tk" }, h("span", { class: "n" }, x.label || x.name), h("span", { class: "p" }, fmt(x.price, x.price > 1000 ? 0 : 2)), h("span", { class: "c " + cls(x.chg1d) }, sgn(x.chg1d)));
  }));
}
function probBar(hp, small) {
  const bar = h("div", { class: "prob", role: "img", "aria-label": `Hausse ${hp.p_hausse} %, stable ${hp.p_stable} %, baisse ${hp.p_baisse} %` });
  [["pu", hp.p_hausse], ["pf", hp.p_stable], ["pd", hp.p_baisse]].forEach(([c, v]) => bar.append(h("div", { class: c, style: `width:${v}%` }, small || v < 9 ? "" : `${v} %`)));
  return bar;
}
const verdictClass = s => s === "Hausse" ? "up" : s === "Baisse" ? "down" : "flat";
function rangeBar(hp) {
  const [lo, hi] = hp.fourchette_68 || [];
  if (!lo || !hi) return null;
  const pos = Math.max(0, Math.min(100, (hp.prix - lo) / (hi - lo) * 100));
  return h("div", {}, h("div", { class: "label" }, "Fourchette probable à 5 séances (68 %)"),
    h("div", { class: "range" }, h("div", { class: "bar" }), h("div", { class: "mk", style: `left:${pos}%`, title: "Cours actuel" }),
      h("span", { class: "lo" }, fmt(lo) + " " + (hp.devise || "")), h("span", { class: "hi" }, fmt(hi) + " " + (hp.devise || ""))));
}
function hypCard(hp, opts = {}) {
  return h("section", { class: "card" },
    h("div", { class: "hyp-head" },
      h("div", {}, h("div", { class: "label" }, opts.label || "Hypothèse de l'algorithme · 5 séances"), h("h2", {}, hp.nom || (hp.symbol === "VWRL.SW" ? "VWRL · Vanguard FTSE All-World" : hp.symbol))),
      h("div", { style: "text-align:right" }, h("div", { class: "verdict " + verdictClass(hp.scenario) }, hp.scenario), h("div", { class: "label" }, "Confiance " + String(hp.confiance || "–").toLowerCase()))),
    probBar(hp),
    h("div", { class: "legend" }, h("span", { class: "up" }, `Hausse ${hp.p_hausse} %`), h("span", { class: "flat" }, `Stable ${hp.p_stable} %`), h("span", { class: "down" }, `Baisse ${hp.p_baisse} %`)),
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("span", { class: "label" }, "Cours"), h("b", {}, fmt(hp.prix) + " " + (hp.devise || ""))),
      h("div", { class: "stat" }, h("span", { class: "label" }, "Score composite"), h("b", { class: cls(hp.score) }, (hp.score > 0 ? "+" : "") + fmt(hp.score, 2)))),
    rangeBar(hp),
    opts.link ? h("a", { class: "more", href: opts.link }, opts.linkText || "Lire le rapport complet") : null);
}
function miniHyp(hp, name) {
  return h("div", { class: "mini" },
    h("div", { class: "hyp-head" }, h("b", {}, name || hp.nom || hp.symbol), h("span", { class: "num " + verdictClass(hp.scenario) }, hp.scenario)),
    probBar(hp, true), h("span", { class: "muted", style: "font-size:13px" }, `Hausse ${hp.p_hausse} % · Stable ${hp.p_stable} % · Baisse ${hp.p_baisse} %`));
}
function alertArticles(hours = 24) {
  const since = Date.now() - hours * 3600e3;
  return ((state.index && state.index.articles) || []).filter(a => ["urgent", "chute", "opportunite"].includes(a.type) && new Date(a.cree_le).getTime() > since);
}
function alertRow(a) {
  return h("a", { class: "alert t-" + a.type, href: "#a-" + a.id }, h("span", { class: "k" }, TYPES[a.type]), h("strong", {}, a.titre), h("small", {}, when(a.cree_le) + (a.chapeau ? " · " + a.chapeau.slice(0, 110) : "")));
}
function liveAlertRow(a) {
  return h("div", { class: "alert t-" + a.type }, h("span", { class: "k" }, TYPES[a.type] || a.type), h("strong", {}, a.titre), h("small", {}, a.detail + " · détecté par la veille automatique"));
}
function isStandalone() { return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; }

// ---------------------------------------------------------------- vues
function viewHome() {
  const box = h("div", { style: "display:flex;flex-direction:column;gap:20px" });
  if (!isStandalone() && store.get("rm-hide-install") !== "1") {
    box.append(h("div", { class: "banner" }, h("p", {}, "Installe Radar Marchés sur ton écran d'accueil pour l'ouvrir comme une app."),
      h("div", { class: "row" }, h("a", { class: "btn", href: "#reglages" }, "Comment faire"), h("button", { class: "btn ghost", type: "button", onclick: () => { store.set("rm-hide-install", "1"); render(); } }, "Plus tard"))));
  }
  if (!store.get("rm-topic")) box.append(h("div", { class: "banner" }, h("p", {}, "Active les notifications pour recevoir les alertes sur ton écran de verrouillage."), h("a", { class: "btn", href: "#reglages" }, "Activer")));
  const al = alertArticles().slice(0, 3);
  if (al.length) box.append(h("section", { class: "alerts", "aria-label": "Alertes récentes" }, al.map(alertRow)));
  const arts = (state.index && state.index.articles) || [];
  const rapport = arts.find(a => a.type === "rapport");
  const hp = state.live && state.live.hypotheses && state.live.hypotheses["VWRL.SW"];
  if (hp) box.append(hypCard(hp, { label: "Hypothèse en direct · mise à jour " + when(state.live.maj), link: rapport ? "#a-" + rapport.id : null, linkText: "Lire le dernier rapport" }));
  const favs = state.live ? Object.entries(state.live.hypotheses || {}).filter(([s]) => s !== "VWRL.SW") : [];
  if (favs.length) box.append(h("div", { class: "minis" }, favs.map(([s, x]) => miniHyp(x, (state.live.favoris_marches[s] || {}).name || s))));
  box.append(feedBlock());
  box.append(h("p", { class: "disclaimer" }, "Hypothèses calculées automatiquement à partir de l'actualité et des cours. Ce n'est pas un conseil en investissement."));
  return box;
}
function feedBlock() {
  const filters = [["tout", "Tout"], ["rapport", "Rapports"], ["urgent", "Urgent"], ["chute", "Chutes"], ["opportunite", "Opportunités"]];
  const arts = ((state.index && state.index.articles) || []).filter(a => state.filter === "tout" || a.type === state.filter);
  const feed = h("div", { class: "feed" });
  if (!state.index) feed.append(h("div", { class: "empty" }, state.error ? "Pas de connexion. Les articles déjà lus restent disponibles." : "Chargement des articles…"));
  else if (!arts.length) feed.append(h("div", { class: "empty" }, "Aucun article dans cette catégorie pour l'instant."));
  arts.slice(0, 80).forEach(a => {
    const [d, t] = timeParts(a.cree_le);
    feed.append(h("a", { class: "item", href: "#a-" + a.id }, h("div", { class: "when" }, d, h("br"), t),
      h("div", { style: "min-width:0" }, h("h3", {}, h("span", { class: "tag " + a.type }, a.type === "rapport" && a.edition ? "Rapport " + a.edition : TYPES[a.type] || a.type), a.titre), h("p", {}, a.chapeau || ""))));
  });
  return h("section", { style: "display:flex;flex-direction:column;gap:12px" },
    h("div", { class: "section-h" }, h("h2", {}, "Articles"), h("div", { class: "chips", role: "group", "aria-label": "Filtrer" }, filters.map(([k, l]) =>
      h("button", { class: "chip", type: "button", "aria-pressed": String(state.filter === k), onclick: () => { state.filter = k; store.set("rm-filter", k); render(); } }, l)))), feed);
}
function viewAlerts() {
  store.set("rm-alerts-seen", String(Date.now()));
  const box = h("div", { style: "display:flex;flex-direction:column;gap:20px" }, h("h2", { style: "font-size:24px" }, "Alertes"));
  const live = (state.live && state.live.alertes) || [];
  box.append(h("section", { style: "display:flex;flex-direction:column;gap:10px" }, h("div", { class: "label" }, "Détectées par la veille automatique · " + (state.live ? when(state.live.maj) : "–")),
    live.length ? h("div", { class: "alerts" }, live.map(liveAlertRow)) : h("div", { class: "empty" }, "Aucune alerte en cours. La veille vérifie les marchés toutes les 10 minutes environ.")));
  const arts = alertArticles(24 * 14);
  box.append(h("section", { style: "display:flex;flex-direction:column;gap:10px" }, h("div", { class: "label" }, "Articles d'alerte · 14 derniers jours"),
    arts.length ? h("div", { class: "alerts" }, arts.map(alertRow)) : h("div", { class: "empty" }, "Aucun article d'alerte récent.")));
  box.append(h("details", { class: "card" }, h("summary", { style: "cursor:pointer;font-weight:600" }, "Quand une alerte est-elle déclenchée ?"),
    h("ul", { class: "steps" },
      h("li", {}, h("b", {}, "Urgent 🚨 : "), "un grand indice (S&P 500, Nasdaq, Euro Stoxx, SMI, Nikkei…) bouge de 2 % ou plus, VWRL de 1,8 % ou plus, le VIX dépasse 30 ou bondit de 20 %, ou un événement grave est confirmé par plusieurs sources."),
      h("li", {}, h("b", {}, "Chute 📉 : "), "une grande entreprise perd au moins 7 % en un jour ou 15 % en cinq jours."),
      h("li", {}, h("b", {}, "Opportunité 💡 : "), "une grande valeur est survendue (RSI sous 28, au moins −15 % depuis son plus haut) sans signe de fraude, faillite ou enquête dans l'actualité. C'est spéculatif."))));
  return box;
}
function viewLive() {
  const L = state.live;
  const box = h("div", { style: "display:flex;flex-direction:column;gap:20px" }, h("div", { class: "section-h" }, h("h2", { style: "font-size:24px" }, "En direct"), h("span", { class: "label" }, L ? "Mise à jour " + when(L.maj) : "")));
  if (!L) { box.append(h("div", { class: "empty" }, state.error ? "Pas de connexion." : "Chargement…")); return box; }
  const rows = MARKET_ORDER.filter(s => L.marches[s] && !L.marches[s].error).map(s => L.marches[s]).concat(Object.values(L.favoris_marches || {}).filter(x => !x.error));
  box.append(h("div", { class: "factors" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Marché"), h("th", {}, "Cours"), h("th", {}, "1 jour"), h("th", {}, "5 jours"), h("th", {}, "1 mois"))),
    h("tbody", {}, rows.map(m => h("tr", {}, h("td", {}, m.label || m.name), h("td", { class: "num" }, fmt(m.price, m.price > 1000 ? 0 : 2)), h("td", { class: "num " + cls(m.chg1d) }, sgn(m.chg1d, 1)), h("td", { class: "num " + cls(m.chg5d) }, sgn(m.chg5d, 1)), h("td", { class: "num " + cls(m.chg20d) }, sgn(m.chg20d, 1))))))));
  const big = L.grandes_entreprises || [];
  if (big.length) box.append(h("div", { class: "prose" }, h("h2", {}, "Grandes entreprises : plus fortes variations")),
    h("div", { class: "factors" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Entreprise"), h("th", {}, "1 jour"), h("th", {}, "5 jours"), h("th", {}, "Depuis le plus haut"))),
      h("tbody", {}, big.map(b => h("tr", {}, h("td", {}, b.name, h("br"), h("span", { class: "muted num" }, b.symbol)), h("td", { class: "num " + cls(b.chg1d) }, sgn(b.chg1d, 1)), h("td", { class: "num " + cls(b.chg5d) }, sgn(b.chg5d, 1)), h("td", { class: "num " + cls(b.drawdown_52w) }, sgn(b.drawdown_52w, 0))))))));
  box.append(h("div", { class: "prose" }, h("h2", {}, "Les titres qui comptent"), h("p", { class: "muted", style: "font-size:14px" }, "Classés par impact estimé sur les marchés. Le nombre de sources indique si l'information est confirmée.")),
    h("ul", { class: "srcs" }, (L.titres || []).map(t => {
      const a = (t.articles || [])[0] || {};
      return h("li", {}, h("span", {}, h("span", { class: "tag " + t.direction }, t.direction), a.link ? h("a", { href: a.link, target: "_blank", rel: "noopener" }, t.title) : t.title),
        h("small", {}, `${t.reliability} · ${(t.articles || []).map(x => x.source).filter((v, i, s) => s.indexOf(v) === i).slice(0, 4).join(", ")} · impact ${Math.round(t.impact)}/100`));
    })));
  return box;
}
function viewSettings() {
  const topic = store.get("rm-topic", "");
  const input = h("input", { id: "topic", value: topic, placeholder: "radar-marches-…", autocomplete: "off", "aria-label": "Nom du canal de notifications" });
  const msg = h("p", { class: "muted", role: "status", style: "margin:0;font-size:14px" });
  const save = () => { const v = input.value.trim().replace(/[^A-Za-z0-9_-]/g, ""); store.set("rm-topic", v); msg.textContent = v ? "Canal enregistré." : "Canal effacé."; render(); };
  const link = topic ? "https://ntfy.sh/" + topic : null;
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua), android = /Android/.test(ua);
  return h("div", { style: "display:flex;flex-direction:column;gap:20px" },
    h("h2", { style: "font-size:24px" }, "Notifications"),
    h("section", { class: "card" },
      h("h2", { style: "font-size:19px" }, "1. Installe l'app ntfy (gratuite)"),
      h("p", { style: "margin:0" }, "ntfy affiche les alertes de Radar Marchés sur ton écran de verrouillage, même téléphone fermé, avec une sonnerie différente selon l'urgence. Un toucher sur la notification ouvre Radar Marchés."),
      h("div", { class: "row" },
        (!android) ? h("a", { class: "btn" + (ios ? "" : " ghost"), href: "https://apps.apple.com/app/ntfy/id1625396347", target: "_blank", rel: "noopener" }, "App Store (iPhone)") : null,
        (!ios) ? h("a", { class: "btn" + (android ? "" : " ghost"), href: "https://play.google.com/store/apps/details?id=io.heckel.ntfy", target: "_blank", rel: "noopener" }, "Google Play (Android)") : null)),
    h("section", { class: "card" },
      h("h2", { style: "font-size:19px" }, "2. Abonne-toi à ton canal privé"),
      topic ? h("p", { class: "ok", style: "margin:0" }, "Ton canal est enregistré sur cet appareil.") : h("p", { style: "margin:0" }, "Colle le nom de canal que Claude t'a donné (il commence par radar-marches-)."),
      h("div", { class: "field" }, input, h("button", { class: "btn", type: "button", onclick: save }, "Enregistrer")), msg,
      topic ? h("ol", { class: "steps" },
        h("li", {}, "Ouvre ntfy, touche ", h("b", {}, "+"), " (S'abonner à un sujet)."),
        h("li", {}, "Saisis le nom du canal : ", h("b", { class: "num", style: "word-break:break-all" }, topic), " ", h("button", { class: "btn ghost", type: "button", style: "padding:3px 9px;font-size:12px", onclick: async e => { try { await navigator.clipboard.writeText(topic); e.target.textContent = "Copié"; } catch (err) { input.select(); } } }, "Copier")),
        h("li", {}, "Serveur : laisse ntfy.sh par défaut, puis valide."),
        h("li", {}, "Autorise les notifications quand ntfy le demande.")) : null,
      link ? h("a", { class: "more", href: link, target: "_blank", rel: "noopener" }, "Voir les derniers messages du canal") : null),
    h("section", { class: "card" },
      h("h2", { style: "font-size:19px" }, "3. Choisis tes sonneries"),
      h("p", { style: "margin:0" }, "Les alertes arrivent avec trois niveaux d'importance :"),
      h("ul", { class: "steps" },
        h("li", {}, h("b", {}, "🚨 Urgent : "), "priorité maximale. Sur Android, sonnerie insistante et vibration longue ; sur iPhone, notification « urgente » qui passe devant les autres."),
        h("li", {}, h("b", {}, "📉 Chute : "), "priorité haute."),
        h("li", {}, h("b", {}, "💡 Opportunité et 📰 rapports : "), "priorité normale.")),
      h("p", { class: "muted", style: "margin:0;font-size:14px" }, android ? "Dans ntfy : Réglages → Notifications, puis choisis un son différent pour chaque priorité." : "Sur iPhone, ntfy utilise le son des notifications du système ; l'emoji et le niveau d'urgence distinguent les alertes.")),
    h("section", { class: "card" },
      h("h2", { style: "font-size:19px" }, "Installer Radar Marchés sur l'écran d'accueil"),
      isStandalone() ? h("p", { class: "ok", style: "margin:0" }, "C'est fait : tu utilises déjà l'app installée.") : null,
      h("ul", { class: "steps" },
        h("li", {}, h("b", {}, "iPhone : "), "ouvre cette page dans Safari, touche le bouton Partager (carré avec une flèche), puis « Sur l'écran d'accueil »."),
        h("li", {}, h("b", {}, "Android : "), "dans Chrome, touche le menu ⋮ puis « Installer l'application » ou « Ajouter à l'écran d'accueil »."),
        h("li", {}, h("b", {}, "PC : "), "dans Chrome ou Edge, clique l'icône d'installation à droite de la barre d'adresse."))),
    h("section", { class: "card" },
      h("h2", { style: "font-size:19px" }, "Favoris"),
      h("p", { style: "margin:0" }, "Ajoute ou retire les actions que l'algorithme doit surveiller de près depuis ton espace Radar Marchés dans Claude. Elles apparaissent ici au rapport suivant."),
      h("a", { class: "btn ghost", href: CLAUDE_APP, target: "_blank", rel: "noopener", style: "align-self:flex-start" }, "Gérer mes favoris")),
    h("p", { class: "disclaimer" }, "Radar Marchés est une aide à la lecture de l'actualité, pas un conseil en investissement."));
}
function factorTable(f) {
  return h("div", { class: "factors" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Facteur"), h("th", {}, "Signal"), h("th", {}, "Poids"), h("th", {}, "Détail"))),
    h("tbody", {}, f.map(x => { const v = x.signal, w = Math.abs(v) * 50; return h("tr", {}, h("td", {}, x.facteur),
      h("td", {}, h("div", { class: "sig" }, h("div", { class: "track" }, h("i", { style: `${v >= 0 ? "left:50%" : "right:50%"};width:${w}%;background:var(${v >= 0 ? "--up" : "--down"})` })), h("span", { class: "num " + cls(v) }, (v > 0 ? "+" : "") + fmt(v, 2)))),
      h("td", { class: "num" }, Math.round(x.poids * 100) + " %"), h("td", { class: "muted" }, x.note)); }))));
}
function viewArticle(a, id) {
  const back = h("a", { class: "back", href: "#accueil" }, "Retour");
  if (a === undefined) { loadArticle(id).then(() => render()); return h("div", { class: "art" }, back, h("div", { class: "empty" }, "Chargement…")); }
  if (!a) return h("div", { class: "art" }, back, h("div", { class: "empty" }, "Article introuvable ou pas de connexion."));
  const art = h("article", { class: "art" }, back,
    h("div", {}, h("span", { class: "tag " + a.type }, a.type === "rapport" && a.edition ? "Rapport " + a.edition : TYPES[a.type]), h("span", { class: "label" }, when(a.cree_le))),
    h("h1", {}, a.titre), a.chapeau ? h("p", { class: "chapeau" }, a.chapeau) : null, a.fiabilite ? h("span", { class: "rel" }, "Fiabilité : " + a.fiabilite) : null);
  if (a.hypothese) art.append(hypCard(a.hypothese, { label: "Hypothèse au moment de l'article · 5 séances" }));
  const prose = h("div", { class: "prose" });
  (a.sections || []).forEach(s => { if (s.titre) prose.append(h("h2", {}, s.titre)); String(s.texte || "").split(/\n\n+/).forEach(p => prose.append(h("p", {}, p))); });
  art.append(prose);
  if (a.mouvements && a.mouvements.length) art.append(h("div", { class: "prose" }, h("h2", {}, "Grandes entreprises à surveiller")),
    h("div", { class: "factors" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Entreprise"), h("th", {}, "1 jour"), h("th", {}, "5 jours"), h("th", {}, "Commentaire"))),
      h("tbody", {}, a.mouvements.map(m => h("tr", {}, h("td", {}, h("b", {}, m.nom), h("br"), h("span", { class: "muted num" }, m.symbole)), h("td", { class: "num " + cls(m.chg1d) }, sgn(m.chg1d, 1)), h("td", { class: "num " + cls(m.chg5d) }, sgn(m.chg5d, 1)), h("td", { class: "muted" }, m.commentaire || "")))))));
  if (a.hypotheses_favoris && a.hypotheses_favoris.length) art.append(h("div", { class: "prose" }, h("h2", {}, "Tes favoris")), h("div", { class: "minis" }, a.hypotheses_favoris.map(x => miniHyp(x))));
  if (a.hypothese && a.hypothese.facteurs) art.append(h("div", { class: "prose" }, h("h2", {}, "Le calcul en détail")), factorTable(a.hypothese.facteurs));
  if (a.actus_monde && a.actus_monde.length) art.append(h("div", { class: "prose" }, h("h2", {}, "Autres actualités importantes")),
    h("ul", { class: "srcs" }, a.actus_monde.map(n => h("li", {}, h("strong", {}, n.titre), n.resume ? h("span", {}, n.resume) : null, h("small", {}, n.lien ? h("a", { href: n.lien, target: "_blank", rel: "noopener" }, n.source) : n.source)))));
  if (a.sources && a.sources.length) art.append(h("div", { class: "prose" }, h("h2", {}, "Sources")),
    h("ul", { class: "srcs" }, a.sources.map(s => h("li", {}, s.lien ? h("a", { href: s.lien, target: "_blank", rel: "noopener" }, s.titre || s.nom) : h("span", {}, s.titre || s.nom), h("small", {}, [s.nom, s.date ? when(s.date) : null].filter(Boolean).join(" · "))))));
  art.append(h("p", { class: "disclaimer" }, "Hypothèse calculée automatiquement à partir de l'actualité et des cours. Ce n'est pas un conseil en investissement."));
  return art;
}

// ---------------------------------------------------------------- rendu
let lastHash = null;
function render() {
  renderEditions(); renderTape();
  $("#updated").textContent = state.live ? "Données " + when(state.live.maj) : state.error ? "Hors connexion" : "Chargement…";
  const hash = location.hash.slice(1) || "accueil";
  const tab = hash.startsWith("a-") ? "accueil" : hash;
  document.querySelectorAll(".tabbar a").forEach(a => { if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  const seen = Number(store.get("rm-alerts-seen", "0"));
  $("#alert-dot").hidden = !alertArticles().some(a => new Date(a.cree_le).getTime() > seen) && !((state.live && state.live.alertes) || []).length;
  let v;
  if (hash.startsWith("a-")) { const id = hash.slice(2); v = viewArticle(state.articles[id], id); }
  else if (hash === "alertes") v = viewAlerts();
  else if (hash === "direct") v = viewLive();
  else if (hash === "reglages") v = viewSettings();
  else v = viewHome();
  const active = document.activeElement && document.activeElement.id;
  $("#view").replaceChildren(v);
  if (active && document.getElementById(active)) document.getElementById(active).focus();
  if (hash !== lastHash) { window.scrollTo(0, 0); lastHash = hash; }
}
window.addEventListener("hashchange", render);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(); });
setInterval(() => { if (document.visibilityState === "visible") load(); }, 5 * 60e3);
render();
load();
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
