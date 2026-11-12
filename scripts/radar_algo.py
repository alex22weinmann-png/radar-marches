#!/usr/bin/env python3
"""Radar Marchés : collecte et algorithme de scoring.

Usage :
  python3 radar_algo.py --mode full  --favorites "NVDA,ROG.SW" --out radar.json
  python3 radar_algo.py --mode watch --favorites "NVDA" --out watch.json

Mode full  : marchés + grosses entreprises + titres de presse + hypothèses.
Mode watch : contrôle rapide (marchés + grosses entreprises + titres) pour
             détecter une alerte urgente, une chute ou une opportunité.

Aucune dépendance obligatoire hors `requests` ; `feedparser` est utilisé s'il
est installé (pip install feedparser), sinon un lecteur RSS minimal prend le relais.
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import email.utils
import json
import math
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET

import requests

try:
    import feedparser  # type: ignore
except Exception:  # pragma: no cover
    feedparser = None

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"}
NOW = dt.datetime.now(dt.timezone.utc)

# ---------------------------------------------------------------------------
# Sources (médias reconnus et institutions officielles uniquement)
# ---------------------------------------------------------------------------
GN = "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q="
FEEDS = [
    # Institutions officielles : information confirmée dès publication
    ("Réserve fédérale US (Fed)", "https://www.federalreserve.gov/feeds/press_all.xml", 1.0, True, "finance"),
    ("Banque centrale européenne", "https://www.ecb.europa.eu/rss/press.html", 1.0, True, "finance"),
    ("Banque nationale suisse (BNS)", "https://www.snb.ch/public/rss/fr/pressrel", 1.0, True, "finance"),
    ("SEC (gendarme boursier US)", "https://www.sec.gov/news/pressreleases.rss", 1.0, True, "finance"),
    # Agences et presse financière
    ("Reuters", GN + "site:reuters.com+(markets+OR+stocks+OR+economy)+when:1d", 0.95, False, "finance"),
    ("Bloomberg", GN + "site:bloomberg.com+(markets+OR+stocks)+when:1d", 0.95, False, "finance"),
    ("Wall Street Journal", GN + "site:wsj.com+(markets+OR+stocks)+when:1d", 0.95, False, "finance"),
    ("Financial Times", "https://www.ft.com/markets?format=rss", 0.95, False, "finance"),
    ("CNBC", GN + "site:cnbc.com+(stocks+OR+markets)+when:1d", 0.85, False, "finance"),
    ("MarketWatch", "https://feeds.content.dowjones.io/public/rss/mw_topstories", 0.85, False, "finance"),
    ("Nasdaq", "https://www.nasdaq.com/feed/rssoutbound?category=Markets", 0.8, False, "finance"),
    ("Nasdaq Actions", "https://www.nasdaq.com/feed/rssoutbound?category=Stocks", 0.8, False, "finance"),
    ("Investing.com", "https://www.investing.com/rss/news_25.rss", 0.75, False, "finance"),
    ("finews.ch", "https://www.finews.ch/news?format=feed&type=rss", 0.8, False, "finance"),
    ("Le Temps Économie", "https://www.letemps.ch/economie.rss", 0.9, False, "finance"),
    ("RTS Économie", "https://www.rts.ch/info/economie/?format=rss/news", 0.9, False, "finance"),
    ("BBC Business", "https://feeds.bbci.co.uk/news/business/rss.xml", 0.9, False, "finance"),
    ("Le Monde Économie", "https://www.lemonde.fr/economie/rss_full.xml", 0.9, False, "finance"),
    # Actualité générale (même sans impact boursier direct)
    ("RTS Info", "https://www.rts.ch/info/?format=rss/news", 0.9, False, "monde"),
    ("BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml", 0.9, False, "monde"),
    ("Le Monde International", "https://www.lemonde.fr/international/rss_full.xml", 0.9, False, "monde"),
]

# Marchés suivis en permanence
CORE = [
    ("VWRL.SW", "VWRL · FTSE All-World (SIX, CHF)"),
    ("^GSPC", "S&P 500"), ("^IXIC", "Nasdaq"), ("^DJI", "Dow Jones"),
    ("^STOXX50E", "Euro Stoxx 50"), ("^SSMI", "SMI Suisse"), ("^N225", "Nikkei 225"),
    ("000001.SS", "Shanghai"), ("^VIX", "VIX · indice de peur"), ("^TNX", "Taux US 10 ans"),
    ("CL=F", "Pétrole WTI"), ("GC=F", "Or"), ("CHF=X", "USD/CHF"), ("EURCHF=X", "EUR/CHF"),
    ("BTC-USD", "Bitcoin"),
]
# Grandes capitalisations surveillées pour les chutes / opportunités
MEGACAPS = ["NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "TSM", "BRK-B",
            "JPM", "LLY", "V", "WMT", "ORCL", "AMD", "NFLX", "PLTR", "ASML.AS", "SAP.DE", "MC.PA",
            "NESN.SW", "NOVN.SW", "ROG.SW", "UBSG.SW", "ABBN.SW", "ZURN.SW", "CFR.SW"]
INDICES = {"^GSPC", "^IXIC", "^DJI", "^STOXX50E", "^SSMI", "^N225", "000001.SS"}

# ---------------------------------------------------------------------------
# Lexique : thèmes et sens probable pour les actions mondiales
# ---------------------------------------------------------------------------
THEMES = {
    "politique_monetaire": (0.95, "Banques centrales et taux",
        r"\b(fed|fomc|powell|ecb|bce|lagarde|snb|bns|central bank|banque centrale|interest rates?|taux d.interet|rate (cut|hike)|bond yields?|treasur)"),
    "inflation": (0.85, "Inflation", r"\b(inflation|cpi|pce|consumer prices|prix a la consommation|deflation)"),
    "emploi_croissance": (0.8, "Croissance et emploi",
        r"\b(gdp|pib|recession|jobs report|payrolls|unemployment|chomage|pmi|growth|croissance|economy)"),
    "geopolitique": (0.9, "Géopolitique et conflits",
        r"\b(war|wars|guerre|invasion|missiles?|military|militaire|attacks?|attaques?|sanctions|ceasefire|cessez|nato|otan|taiwan|iran|israel|ukraine|russia|russie)\b"),
    "commerce": (0.85, "Commerce et droits de douane",
        r"\b(tariffs?|droits? de douane|trade (war|deal|talks)|guerre commerciale|export (ban|controls)|accord commercial)"),
    "energie": (0.7, "Énergie et matières premières", r"\b(oil|petrole|brent|opec|opep|natural gas|gaz|energy|energie)"),
    "banques_credit": (0.9, "Banques et crédit",
        r"\b(bank (run|collapse|failure)|faillite|bankrupt|default|defaut|credit crunch|liquidity|downgrade|degrad)"),
    "tech_ia": (0.85, "Tech et IA (≈25 % de VWRL)",
        r"\b(nvidia|apple|microsoft|alphabet|google|amazon|meta|tesla|broadcom|tsmc|semiconductor|chip|puce|artificial intelligence|\bai\b|intelligence artificielle)"),
    "resultats": (0.6, "Résultats d'entreprises", r"\b(earnings|resultats|profit|revenue|chiffre d.affaires|guidance|outlook|beneficE?)"),
    "marches": (0.75, "Marchés", r"\b(stocks?|shares|wall street|bourse|equities|actions|nasdaq|s&p|dow|smi|index|indice|selloff|sell-off|rally)"),
    "suisse_chf": (0.6, "Suisse et franc", r"\b(swiss franc|franc suisse|chf|suisse|switzerland|ubs|nestle|roche|novartis)"),
    "chine": (0.7, "Chine", r"\b(china|chine|beijing|pekin|yuan|xi jinping)"),
}
# (motif, points, explication). Positif = plutôt favorable aux actions.
RULES = [
    (r"\b(rate cuts?|cuts? (interest )?rates|baisse (des|de ses) taux|abaisse (ses|les) taux|dovish)", 2.0, "baisse des taux"),
    (r"\b(rate hikes?|raises? (interest )?rates|hausse (des|de ses) taux|releve (ses|les) taux|hawkish)", -2.0, "hausse des taux"),
    (r"\binflation\W+(\w+\W+){0,3}(rises?|rose|accelerat|hotter|higher|jumps?|accelere|hausse|grimpe)", -1.8, "inflation en hausse"),
    (r"\binflation\W+(\w+\W+){0,3}(eases?|cools?|slows?|falls?|lower|ralentit|recule|baisse)", 1.8, "inflation en recul"),
    (r"\b(recession|contraction|layoffs|licenciements|job cuts|stagflation)", -1.5, "risque de récession"),
    (r"\b(war|wars|guerre|invasion|missiles?|airstrikes?|frappes?|attacks?|attaques?|bombard\w*)\b", -1.5, "conflit armé"),
    (r"\b(ceasefire|cessez-le-feu|peace (deal|talks)|accord de paix|truce|treve)", 1.5, "apaisement géopolitique"),
    (r"\b(tariffs?|droits? de douane|trade war|guerre commerciale|export (ban|controls)|sanctions)\b", -1.3, "tensions commerciales"),
    (r"\b(trade deal|accord commercial|tariff (pause|relief|cut)|suspend\w* (the )?tariffs?)", 1.5, "détente commerciale"),
    (r"\b(oil|petrole|brent|crude)\W+(\w+\W+){0,3}(surge|soar|jump|spike|flambe|bondit|grimpe)", -1.3, "flambée du pétrole"),
    (r"\b(oil|petrole|brent|crude)\W+(\w+\W+){0,3}(plunge|tumble|slump|fall|chute|recule)", 0.6, "baisse du pétrole"),
    (r"\b(default|defaut de paiement|bankruptcy|faillite|bank run|collapse|effondrement|fraud|fraude)", -2.0, "stress financier"),
    (r"\b(stocks?|shares|markets?|wall street|equities|bourses?|actions|indices|nasdaq|s&p|dow)\W+(\w+\W+){0,3}(rally|rallies|surge|soar|jump|gain|rise|record|rebound|bondi|grimpe|monte|hausse|rebond)", 1.3, "marchés en hausse"),
    (r"\b(stocks?|shares|markets?|wall street|equities|bourses?|actions|indices|nasdaq|s&p|dow)\W+(\w+\W+){0,3}(plunge|tumble|slump|fall|drop|sink|selloff|sell-off|crash|chute|recule|baisse|plonge|degringol)", -1.3, "marchés en baisse"),
    (r"\b(record high|all-time high|plus haut historique|nouveau record)", 1.0, "records boursiers"),
    (r"\b(beats? (estimates|expectations)|depasse les attentes|strong (results|earnings|demand)|raises? (guidance|outlook)|upgrade)", 1.2, "bons résultats"),
    (r"\b(miss(es)? (estimates|expectations)|decoit|cuts? (guidance|outlook)|profit warning|avertissement|downgrade|warns?)", -1.2, "résultats décevants"),
    (r"\b(resigns?|demissionne|steps down|ousted|investigation|enquete|probe|lawsuit)", -0.8, "incertitude sur la direction ou procès"),
    (r"\b(fears?|worr(y|ies)|concerns?|craintes?|inquietude|turmoil|uncertainty|incertitude|crisis|crise)", -0.6, "inquiétude"),
    (r"\b(optimism|optimisme|hopes?|espoir|confidence|confiance|stimulus|relance)", 0.6, "optimisme"),
]
NEWS_BIAS = -0.30
STOP = set("the a an of to in on for and or with at by from as is are was be has have after over amid its it this that new says said will could may more than into about les la le des du de et en un une au aux pour par sur dans avec qui que est sont plus ses son leur".split())


def norm(text):
    t = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", t)


def get(url, timeout=15):
    r = requests.get(url, headers=UA, timeout=timeout)
    r.raise_for_status()
    return r


# ---------------------------------------------------------------------------
# Marchés
# ---------------------------------------------------------------------------
def fetch_chart(symbol, rng="1y"):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range={rng}&interval=1d"
    try:
        d = get(url).json()["chart"]["result"][0]
    except Exception as e:  # noqa: BLE001
        return {"symbol": symbol, "error": str(e)[:120]}
    meta = d.get("meta", {})
    closes = [c for c in (d.get("indicators", {}).get("quote", [{}])[0].get("close") or []) if c is not None]
    price = meta.get("regularMarketPrice") or (closes[-1] if closes else None)
    prev = meta.get("chartPreviousClose") if len(closes) < 2 else closes[-2]
    # Si la dernière clôture == prix courant, la veille est l'avant-dernière clôture
    if closes and price and abs(closes[-1] - price) / price > 1e-6:
        prev = closes[-1]
    return {"symbol": symbol, "name": meta.get("shortName") or meta.get("longName") or symbol,
            "currency": meta.get("currency"), "price": price, "prev": prev, "closes": closes,
            "time": meta.get("regularMarketTime"), "exchange": meta.get("exchangeName")}


def pct(a, b):
    return (a / b - 1) * 100 if a and b else None


def indicators(c):
    closes = c.get("closes") or []
    p = c.get("price")
    out = {"price": p, "chg1d": pct(p, c.get("prev"))}
    if len(closes) < 25 or not p:
        return out
    series = closes[:-1] + [p] if abs(closes[-1] - p) / p < 0.2 else closes
    rets = [math.log(series[i] / series[i - 1]) for i in range(1, len(series)) if series[i - 1]]
    last20 = rets[-20:]
    mu = sum(last20) / len(last20)
    vol_d = math.sqrt(sum((r - mu) ** 2 for r in last20) / (len(last20) - 1))
    gains = [max(r, 0) for r in rets[-14:]]
    losses = [max(-r, 0) for r in rets[-14:]]
    ag, al = sum(gains) / 14, sum(losses) / 14
    rsi = 100 - 100 / (1 + ag / al) if al > 0 else 100.0
    ma50 = sum(series[-50:]) / min(50, len(series))
    hi = max(series[-252:])
    out.update({
        "chg5d": pct(p, series[-6]) if len(series) > 6 else None,
        "chg20d": pct(p, series[-21]) if len(series) > 21 else None,
        "chg_ytd": None,
        "vol_ann": vol_d * math.sqrt(252) * 100,
        "vol_d": vol_d,
        "rsi14": rsi,
        "ma50_gap": pct(p, ma50),
        "drawdown_52w": pct(p, hi),
    })
    return out


def fetch_markets(symbols):
    with cf.ThreadPoolExecutor(10) as ex:
        charts = list(ex.map(fetch_chart, symbols))
    res = {}
    for c in charts:
        if c.get("error"):
            res[c["symbol"]] = {"symbol": c["symbol"], "error": c["error"]}
            continue
        ind = indicators(c)
        res[c["symbol"]] = {"symbol": c["symbol"], "name": c["name"], "currency": c["currency"],
                            "exchange": c.get("exchange"),
                            "as_of": dt.datetime.fromtimestamp(c["time"], dt.timezone.utc).isoformat() if c.get("time") else None,
                            **{k: (round(v, 4) if isinstance(v, float) else v) for k, v in ind.items() if k != "vol_d"},
                            "_vol_d": ind.get("vol_d")}
    return res


def fetch_screeners():
    out = {}
    for scr in ("day_losers", "day_gainers", "most_actives"):
        url = f"https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds={scr}&count=50"
        try:
            quotes = get(url).json()["finance"]["result"][0]["quotes"]
        except Exception:  # noqa: BLE001
            quotes = []
        out[scr] = [{"symbol": q.get("symbol"), "name": q.get("shortName") or q.get("longName"),
                     "chg1d": q.get("regularMarketChangePercent"), "price": q.get("regularMarketPrice"),
                     "market_cap_bn": round((q.get("marketCap") or 0) / 1e9, 1)} for q in quotes]
    return out


# ---------------------------------------------------------------------------
# Presse
# ---------------------------------------------------------------------------
def parse_date(s):
    if not s:
        return None
    try:
        d = email.utils.parsedate_to_datetime(s)
    except Exception:  # noqa: BLE001
        try:
            d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:  # noqa: BLE001
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d


def read_feed(src):
    name, url, cred, official, cat = src
    try:
        raw = get(url).content
    except Exception as e:  # noqa: BLE001
        return name, [], str(e)[:100]
    items = []
    if feedparser:
        f = feedparser.parse(raw)
        for e in f.entries:
            d = None
            for k in ("published_parsed", "updated_parsed"):
                if e.get(k):
                    d = dt.datetime(*e[k][:6], tzinfo=dt.timezone.utc)
                    break
            items.append({"title": e.get("title", ""), "link": e.get("link", ""),
                          "summary": re.sub("<[^>]+>", "", e.get("summary", ""))[:400], "date": d})
    else:
        root = ET.fromstring(raw)
        for it in root.iter():
            if it.tag.endswith("item") or it.tag.endswith("entry"):
                g = lambda t: next((c.text or "" for c in it if c.tag.endswith(t)), "")  # noqa: E731
                link = g("link") or next((c.get("href") for c in it if c.tag.endswith("link")), "")
                items.append({"title": g("title"), "link": link, "summary": re.sub("<[^>]+>", "", g("description") or g("summary"))[:400],
                              "date": parse_date(g("pubDate") or g("updated") or g("published"))})
    out = []
    for it in items:
        title = it["title"].strip()
        source_name = name
        # Google News : "Titre - Reuters" -> on garde le média réel
        if "news.google.com" in url and " - " in title:
            title, real = title.rsplit(" - ", 1)
            source_name = real.strip()
        age_h = (NOW - it["date"]).total_seconds() / 3600 if it["date"] else 12
        if age_h > 36 or not title:
            continue
        out.append({"title": title, "link": it["link"], "summary": it["summary"], "source": source_name,
                    "credibility": cred, "official": official, "category": cat,
                    "published": it["date"].isoformat() if it["date"] else None, "age_h": round(age_h, 1)})
    return name, out, None


def score_item(it):
    txt = norm(it["title"] + " " + it["summary"])
    themes = [k for k, (w, _l, pat) in THEMES.items() if re.search(pat, txt)]
    pts, why = 0.0, []
    for pat, p, label in RULES:
        if re.search(pat, txt):
            pts += p
            why.append(label)
    sent = math.tanh(pts / 2.5)
    tw = max([THEMES[t][0] for t in themes], default=0.3)
    recency = math.exp(-it["age_h"] / 24)
    importance = tw * (0.45 + 0.55 * abs(sent)) * it["credibility"] * (0.35 + 0.65 * recency)
    it.update({"themes": themes, "sentiment": round(sent, 3), "signals": why, "importance": round(importance, 3)})
    return it


def tokens(title):
    return {w[:6] for w in re.findall(r"[a-z0-9]+", norm(title)) if len(w) > 3 and w not in STOP}


def cluster(items):
    items = sorted(items, key=lambda x: -x["importance"])
    clusters = []
    for it in items:
        tk = tokens(it["title"])
        best, best_sim = None, 0
        for c in clusters:
            inter = len(tk & c["tokens"])
            sim = inter / max(1, min(len(tk), len(c["rep_tokens"])))
            if sim > best_sim:
                best, best_sim = c, sim
        if best and best_sim >= 0.5 and len(tk & best["rep_tokens"]) >= 2:
            best["items"].append(it)
            best["tokens"] |= tk
        else:
            clusters.append({"items": [it], "tokens": set(tk), "rep_tokens": set(tk)})
    events = []
    for c in clusters:
        its = c["items"]
        sources = sorted({i["source"] for i in its})
        official = any(i["official"] for i in its)
        n = len(sources)
        conf = 1.0 if official else 1 - math.exp(-n / 1.4)
        wsum = sum(i["importance"] for i in its) or 1
        sent = sum(i["sentiment"] * i["importance"] for i in its) / wsum
        lead = its[0]
        themes = sorted({t for i in its for t in i["themes"]})
        tw = max([THEMES[t][0] for t in themes], default=0.3)
        coverage = 1 + 0.22 * math.log(n)  # un sujet repris par beaucoup de médias pèse plus
        impact = 80 * tw * (0.35 + 0.65 * abs(sent)) * (0.45 + 0.55 * conf) * coverage * (0.4 + 0.6 * math.exp(-min(i["age_h"] for i in its) / 18))
        events.append({
            "title": lead["title"], "category": "finance" if any(i["category"] == "finance" for i in its) else "monde",
            "sentiment": round(sent, 3), "direction": "hausse" if sent > 0.15 else "baisse" if sent < -0.15 else "neutre",
            "impact": round(min(100, impact), 1), "n_sources": n, "official": official,
            "reliability": "Source officielle" if official else ("Confirmé par plusieurs sources" if n >= 2 else "Source unique, à confirmer"),
            "themes": [THEMES[t][1] for t in themes], "signals": sorted({s for i in its for s in i["signals"]}),
            "articles": [{"source": i["source"], "title": i["title"], "link": i["link"], "published": i["published"]} for i in its][:6],
        })
    return sorted(events, key=lambda e: -e["impact"])


def fetch_news():
    with cf.ThreadPoolExecutor(12) as ex:
        results = list(ex.map(read_feed, FEEDS))
    items, status = [], []
    for name, its, err in results:
        status.append({"feed": name, "items": len(its), "error": err})
        items += its
    items = [score_item(i) for i in items]
    return cluster(items), status


# ---------------------------------------------------------------------------
# Algorithme d'hypothèse
# ---------------------------------------------------------------------------
def th(x):
    return math.tanh(x)


def hypothesis(sym, m, markets, news_index):
    """Score composite dans [-1, 1] -> probabilités hausse / stable / baisse à 5 séances."""
    if not m or m.get("error") or not m.get("price"):
        return None
    vix = markets.get("^VIX", {})
    tnx = markets.get("^TNX", {})
    oil = markets.get("CL=F", {})
    usd = markets.get("CHF=X", {})
    f = []

    def add(name, value, weight, note):
        if value is None:
            return
        f.append({"facteur": name, "signal": round(max(-1, min(1, value)), 3), "poids": weight, "note": note})

    vol_d = m.get("_vol_d") or 0.01
    if m.get("chg20d") is not None:
        z = (m["chg20d"] / 100) / (vol_d * math.sqrt(20))
        add("Tendance 1 mois", th(z), 0.18, f"{m['chg20d']:+.1f} % sur 20 séances (z = {z:+.2f})")
    if m.get("ma50_gap") is not None:
        add("Position vs moyenne 50 j", th(m["ma50_gap"] / 4), 0.10, f"{m['ma50_gap']:+.1f} % par rapport à la moyenne 50 jours")
    if m.get("rsi14") is not None:
        r = m["rsi14"]
        sig = -(r - 70) / 30 if r > 70 else (30 - r) / 30 if r < 30 else 0.0
        add("RSI 14 (surachat/survente)", sig, 0.08, f"RSI = {r:.0f} (" + ("surachat" if r > 70 else "survente" if r < 30 else "neutre") + ")")
    if vix.get("price"):
        add("Niveau de peur (VIX)", -th((vix["price"] - 19) / 7), 0.14, f"VIX = {vix['price']:.1f} (normal ≈ 15-20)")
        if vix.get("chg5d") is not None:
            add("Évolution de la peur 5 j", -th(vix["chg5d"] / 25), 0.05, f"VIX {vix['chg5d']:+.1f} % sur 5 jours")
    if tnx.get("price") and tnx.get("chg5d") is not None:
        bp = tnx["price"] * tnx["chg5d"]  # variation en points de base (approx.)
        add("Taux US 10 ans", -th(bp / 20), 0.09, f"{tnx['price']:.2f} %, {bp:+.0f} pb sur 5 jours")
    if oil.get("chg5d") is not None:
        add("Pétrole", -th(oil["chg5d"] / 10), 0.04, f"WTI {oil['chg5d']:+.1f} % sur 5 jours")
    if m.get("currency") == "CHF" and usd.get("chg5d") is not None:
        add("Dollar / franc suisse", th(usd["chg5d"] / 2), 0.07, f"USD/CHF {usd['chg5d']:+.1f} % sur 5 jours (un franc fort réduit la valeur en CHF)")
    add("Actualité (analyse des titres)", news_index, 0.25, f"Indice de sentiment pondéré = {news_index:+.2f}")

    wsum = sum(x["poids"] for x in f)
    S = sum(x["signal"] * x["poids"] for x in f) / wsum
    for x in f:
        x["contribution"] = round(x["signal"] * x["poids"] / wsum, 3)
    vol_ann = (m.get("vol_ann") or 15) / 100
    lu, ld = 0.08 + 2.4 * S, -0.08 - 2.4 * S
    lf = 0.55 - 2.0 * max(0, vol_ann - 0.14)
    ex = [math.exp(v) for v in (lu, lf, ld)]
    tot = sum(ex)
    p_up, p_flat, p_down = (round(100 * e / tot) for e in ex)
    agree = sum(x["poids"] for x in f if x["signal"] * S > 0) / wsum
    conf_val = abs(S) * 0.6 + agree * 0.4
    confidence = "Élevée" if conf_val > 0.55 else "Moyenne" if conf_val > 0.35 else "Faible"
    move = math.exp(vol_d * math.sqrt(5))
    scenario = "Hausse" if p_up >= max(p_flat, p_down) else "Baisse" if p_down >= max(p_up, p_flat) else "Stable"
    return {"symbol": sym, "score": round(S, 3), "scenario": scenario, "p_hausse": p_up, "p_stable": p_flat,
            "p_baisse": p_down, "confiance": confidence, "horizon": "5 séances",
            "fourchette_68": [round(m["price"] / move, 2), round(m["price"] * move, 2)],
            "prix": m["price"], "devise": m.get("currency"), "facteurs": f}


def news_index(events, symbol_terms=None):
    rel = events
    if symbol_terms:
        rel = [e for e in events if any(t in norm(e["title"]) for t in symbol_terms)] or []
    fin = [e for e in rel if e["category"] == "finance" or e["themes"]]
    w = sum(e["impact"] for e in fin[:40]) or 1
    if not fin:
        return 0.0
    raw = sum(e["sentiment"] * e["impact"] for e in fin[:40]) / w
    # La presse a un biais négatif structurel (≈ -0.3) : on le retire avant d'interpréter.
    return round(math.tanh((raw - NEWS_BIAS) * 1.6), 3)


# ---------------------------------------------------------------------------
# Alertes : urgentes, chutes, opportunités
# ---------------------------------------------------------------------------
def detect_alerts(markets, screens, favorites, events):
    today = NOW.strftime("%Y-%m-%d")
    alerts = []

    def A(kind, level, key, title, detail, symbol=None):
        alerts.append({"type": kind, "niveau": level, "cle": f"{today}:{kind}:{key}", "titre": title,
                       "detail": detail, "symbol": symbol})

    def c1(s):
        return (markets.get(s) or {}).get("chg1d")

    for s in INDICES | {"VWRL.SW"}:
        v = c1(s)
        if v is not None and abs(v) >= (2.0 if s != "VWRL.SW" else 1.8):
            A("urgent", "rouge", s, f"{markets[s]['name']} {v:+.1f} % aujourd'hui", "Mouvement de marché important", s)
    vix = markets.get("^VIX", {})
    if vix.get("price") and (vix["price"] >= 30 or (vix.get("chg1d") or 0) >= 20):
        A("urgent", "rouge", "VIX", f"Peur en forte hausse : VIX à {vix['price']:.1f} ({vix.get('chg1d', 0):+.0f} %)", "Stress élevé sur les marchés", "^VIX")
    for s, lim in (("CL=F", 6), ("CHF=X", 1.5), ("EURCHF=X", 1.5), ("GC=F", 4), ("BTC-USD", 10)):
        v = c1(s)
        if v is not None and abs(v) >= lim:
            A("urgent", "orange", s, f"{markets[s]['name']} {v:+.1f} % aujourd'hui", "Mouvement inhabituel", s)
    tnx = markets.get("^TNX", {})
    if tnx.get("price") and tnx.get("chg1d") is not None and abs(tnx["price"] * tnx["chg1d"]) >= 12:
        A("urgent", "orange", "TNX", f"Taux US 10 ans {tnx['price'] * tnx['chg1d']:+.0f} pb aujourd'hui", "Choc de taux", "^TNX")

    # Grosses entreprises : chutes graves
    seen = set()
    big = [(s, markets[s]) for s in MEGACAPS + favorites if s in markets and not markets[s].get("error")]
    for s, m in big:
        v = m.get("chg1d")
        v5 = m.get("chg5d")
        if (v is not None and v <= -7) or (v5 is not None and v5 <= -15):
            seen.add(s)
            A("chute", "orange", s, f"{m['name']} chute : {v:+.1f} % (1 j), {v5 or 0:+.1f} % (5 j)",
              f"Recul depuis le plus haut sur 1 an : {m.get('drawdown_52w', 0):.0f} %", s)
    for q in screens.get("day_losers", []):
        if q["symbol"] not in seen and (q["market_cap_bn"] or 0) >= 20 and (q["chg1d"] or 0) <= -8:
            A("chute", "orange", q["symbol"], f"{q['name']} chute de {q['chg1d']:.1f} % (capitalisation {q['market_cap_bn']:.0f} Md$)",
              "Grosse entreprise en forte baisse (Wall Street)", q["symbol"])

    # Opportunités court terme (spéculatif) : grosse valeur survendue sans signal de faillite/fraude
    danger = re.compile(r"(fraud|fraude|bankrupt|faillite|default|investigation|enquete)")
    for s, m in big:
        rsi, dd, v5 = m.get("rsi14"), m.get("drawdown_52w"), m.get("chg5d")
        if rsi is not None and rsi < 28 and dd is not None and dd <= -15 and v5 is not None and v5 <= -6:
            name_n = norm(m["name"]).split()[0]
            bad = any(danger.search(norm(e["title"])) and name_n in norm(e["title"]) for e in events)
            if not bad:
                A("opportunite", "vert", s, f"Rebond possible : {m['name']} survendue (RSI {rsi:.0f}, {dd:.0f} % depuis le plus haut)",
                  "Signal technique de survente sur une grande entreprise ; spéculatif, à confirmer par l'actualité", s)
    for q in screens.get("day_gainers", []):
        if (q["market_cap_bn"] or 0) >= 50 and (q["chg1d"] or 0) >= 8:
            A("opportunite", "vert", "G" + q["symbol"], f"{q['name']} bondit de {q['chg1d']:+.1f} % (capitalisation {q['market_cap_bn']:.0f} Md$)",
              "Fort mouvement haussier d'une grande entreprise ; vérifier la cause avant toute décision", q["symbol"])
    # Événements de presse critiques confirmés
    for e in events[:15]:
        if e["impact"] >= 70 and e["direction"] == "baisse" and (e["official"] or e["n_sources"] >= 2):
            A("urgent", "rouge", "N" + "".join(sorted(tokens(e["title"])))[:40], e["title"],
              f"Événement confirmé ({e['reliability']}), impact estimé {e['impact']:.0f}/100", None)
    return alerts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["full", "watch"], default="full")
    ap.add_argument("--favorites", default="", help="Symboles Yahoo séparés par des virgules (ex: NVDA,ROG.SW)")
    ap.add_argument("--out", default="radar.json")
    a = ap.parse_args()
    favs = [s.strip().upper() for s in a.favorites.split(",") if s.strip()]
    symbols = list(dict.fromkeys([s for s, _ in CORE] + MEGACAPS + favs))
    with cf.ThreadPoolExecutor(3) as ex:
        fm = ex.submit(fetch_markets, symbols)
        fs = ex.submit(fetch_screeners)
        fn = ex.submit(fetch_news)
        markets, screens, (events, feed_status) = fm.result(), fs.result(), fn.result()
    for s, label in CORE:
        if s in markets and not markets[s].get("error"):
            markets[s]["label"] = label
    ni = news_index(events)
    hyps = {}
    for s in ["VWRL.SW"] + favs:
        terms = None
        if s != "VWRL.SW" and s in markets and markets[s].get("name"):
            terms = [norm(markets[s]["name"]).split()[0], s.split(".")[0].lower()]
        idx = ni if terms is None else round(0.5 * ni + 0.5 * news_index(events, terms), 3)
        h = hypothesis(s, markets.get(s), markets, idx)
        if h:
            hyps[s] = h
    alerts = detect_alerts(markets, screens, favs, events)
    for m in markets.values():
        m.pop("_vol_d", None)
    big_moves = sorted([{"symbol": s, "name": markets[s].get("name"), "chg1d": markets[s].get("chg1d"), "chg5d": markets[s].get("chg5d"),
                         "drawdown_52w": markets[s].get("drawdown_52w"), "rsi14": markets[s].get("rsi14")}
                        for s in MEGACAPS if s in markets and markets[s].get("chg1d") is not None],
                       key=lambda x: x["chg1d"])
    out = {
        "genere_le": NOW.isoformat(), "mode": a.mode, "favoris": favs,
        "indice_actualite": ni, "hypotheses": hyps, "alertes": alerts,
        "marches": {s: markets[s] for s, _ in CORE if s in markets},
        "favoris_marches": {s: markets[s] for s in favs if s in markets},
        "grandes_entreprises": big_moves,
        "wall_street": {k: v[:12] for k, v in screens.items()},
        "evenements": events[:60 if a.mode == "full" else 25],
        "flux": feed_status,
    }
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1, default=str)
    ok = sum(1 for f in feed_status if f["items"])
    print(f"OK {a.mode}: {len(events)} événements, {ok}/{len(feed_status)} flux, {len(markets)} cours, {len(alerts)} alertes -> {a.out}")
    for al in alerts:
        print(f"  [{al['type']}] {al['titre']}")
    if "VWRL.SW" in hyps:
        h = hyps["VWRL.SW"]
        print(f"  VWRL: {h['scenario']} (hausse {h['p_hausse']}%, stable {h['p_stable']}%, baisse {h['p_baisse']}%), score {h['score']:+.2f}, confiance {h['confiance']}")


if __name__ == "__main__":
    sys.exit(main())
