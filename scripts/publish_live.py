#!/usr/bin/env python3
"""Veille rapide (GitHub Actions, toutes les ~10 minutes).

1. Lance radar_algo.py en mode watch (cours, grandes entreprises, titres de presse).
2. Écrit data/live.json pour l'application (cours, hypothèses, alertes, titres).
3. Envoie une notification ntfy pour chaque alerte nouvelle :
   🚨 urgent (priorité max), 📉 chute (haute), 💡 opportunité (normale).

Variables d'environnement : NTFY_TOPIC (secret), APP_URL (adresse de la PWA).
"""
import json
import os
import pathlib
import subprocess
import sys

import requests

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SENT = DATA / "alertes_envoyees.json"
TOPIC = os.environ.get("NTFY_TOPIC", "").strip()
APP_URL = os.environ.get("APP_URL", "").rstrip("/")

STYLE = {
    "urgent": {"emoji": "🚨", "label": "URGENT", "priority": 5, "tags": ["rotating_light"]},
    "chute": {"emoji": "📉", "label": "CHUTE", "priority": 4, "tags": ["chart_with_downwards_trend"]},
    "opportunite": {"emoji": "💡", "label": "OPPORTUNITÉ", "priority": 3, "tags": ["bulb"]},
}


def favorites():
    try:
        return ",".join(f["symbole"] for f in json.loads((DATA / "favoris.json").read_text())["favoris"])
    except Exception:  # noqa: BLE001
        return ""


def notify(alert):
    if not TOPIC:
        print("NTFY_TOPIC absent : notification non envoyée")
        return
    st = STYLE.get(alert["type"], STYLE["urgent"])
    body = {
        "topic": TOPIC,
        "title": f"{st['emoji']} {st['label']} · {alert['titre']}"[:120],
        "message": alert["detail"] + (" (spéculatif, pas un conseil)" if alert["type"] == "opportunite" else ""),
        "priority": st["priority"],
        "tags": st["tags"],
    }
    if APP_URL:
        body["click"] = f"{APP_URL}/#alertes"
    r = requests.post("https://ntfy.sh/", json=body, timeout=15)
    print("ntfy", r.status_code, body["title"])


def main():
    DATA.mkdir(exist_ok=True)
    out = DATA / "_watch.json"
    subprocess.run([sys.executable, str(ROOT / "scripts" / "radar_algo.py"), "--mode", "watch",
                    "--favorites", favorites(), "--out", str(out)], check=True)
    w = json.loads(out.read_text())
    out.unlink()
    sent = json.loads(SENT.read_text()) if SENT.exists() else []
    new = [a for a in w["alertes"] if a["cle"] not in sent]
    order = {"urgent": 0, "chute": 1, "opportunite": 2}
    for a in sorted(new, key=lambda x: order.get(x["type"], 9))[:4]:
        notify(a)
    sent = (sent + [a["cle"] for a in new])[-400:]
    SENT.write_text(json.dumps(sent, ensure_ascii=False))
    live = {
        "maj": w["genere_le"],
        "hypotheses": w["hypotheses"],
        "alertes": w["alertes"],
        "marches": w["marches"],
        "favoris_marches": w["favoris_marches"],
        "grandes_entreprises": w["grandes_entreprises"][:6] + w["grandes_entreprises"][-6:],
        "titres": [{k: e[k] for k in ("title", "direction", "impact", "n_sources", "reliability", "category", "articles")}
                   for e in w["evenements"][:20]],
    }
    (DATA / "live.json").write_text(json.dumps(live, ensure_ascii=False, default=str))
    print(f"live.json écrit, {len(new)} alerte(s) nouvelle(s)")


if __name__ == "__main__":
    main()
