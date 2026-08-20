#!/usr/bin/env python3
"""One-command refractor registration into the single dict file.

    python scripts/add_type.py --pattern hyper --color 无 \
        --series panini-prizm --name Hyper折 --name-en Hyper \
        --keywords "hyper,海波折,炫彩折射"

Appends one entry to ``dicts/refractions.yml`` (merging keywords/names if the
(pattern,color) already exists) and rebuilds the vector store. That is the whole
maintenance surface — no enum / types / series files to touch.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DICTS = ROOT / "dicts"
DICT_FILE = DICTS / "refractions.yml"


def load() -> dict:
    with DICT_FILE.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def save(doc: dict) -> None:
    with DICT_FILE.open("w", encoding="utf-8") as fh:
        yaml.safe_dump(doc, fh, allow_unicode=True, sort_keys=False)


def register(pattern: str, color: str, keywords: list[str],
             series: str, name: str, name_en: str) -> list[str]:
    changed: list[str] = []
    doc = load()
    entries = doc.setdefault("refractions", [])
    for e in entries:
        if e.get("pattern") == pattern and e.get("color") == color:
            merged = list(e.get("keywords", []))
            added = [k for k in keywords if k not in merged]
            if added:
                e["keywords"] = merged + added
                changed.append(f"refractions.{pattern}-{color}.keywords += {added}")
            names = e.setdefault("names", {})
            if series not in names:
                names[series] = {"name": name, "name_en": name_en}
                changed.append(f"refractions.{pattern}-{color}.names.{series} += {name}/{name_en}")
            save(doc)
            return changed
    entries.append({
        "pattern": pattern,
        "color": color,
        "keywords": keywords,
        "names": {series: {"name": name, "name_en": name_en}},
    })
    changed.append(f"refractions.{pattern}-{color} registered ({name}/{name_en} in {series})")
    save(doc)
    return changed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pattern", required=True, help="pattern value, e.g. hyper")
    ap.add_argument("--color", required=True, help="color value, e.g. 无")
    ap.add_argument("--series", required=True, help="series key, e.g. panini-prizm")
    ap.add_argument("--name", required=True, help="series-facing Chinese term, e.g. Hyper折")
    ap.add_argument("--name-en", required=True, dest="name_en", help="English term, e.g. Hyper")
    ap.add_argument("--keywords", default="", help="comma-separated aliases/descriptors")
    args = ap.parse_args()

    keywords = [k.strip() for k in args.keywords.split(",") if k.strip()]
    if args.pattern not in keywords:
        keywords.insert(0, args.pattern)

    changes = register(args.pattern, args.color, keywords,
                       args.series, args.name, args.name_en)
    for c in changes:
        print(f"[add] {c}")
    if not changes:
        print("[add] nothing to change — already registered")

    print("\n== rebuild vector store ==")
    return subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "embed.py"), "--dict-dir", str(DICTS)],
    ).returncode


if __name__ == "__main__":
    sys.exit(main())
