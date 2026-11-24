#!/usr/bin/env python3
"""
Flight Companion: guides (clouds, India from the air).

The text lives in pipeline/guides.json, written by hand. This script adds a
photo to each entry: the lead image of its Wikipedia article, free licences
only, with author and licence for the credit line. Writes public/data/guides.json.
Run: python pipeline/build_guides.py
"""
import html
import json
import re
import sys
import time
from pathlib import Path

import requests

UA = "FlightCompanion/0.1 (https://github.com/anuragraj12/flight-window)"
API = "https://en.wikipedia.org/w/api.php"
SRC, OUT = Path("pipeline/guides.json"), Path("public/data/guides.json")
NONFREE = re.compile(r"fair use|non-free", re.I)


def get(s, **params):
    r = s.get(API, params={"format": "json", "formatversion": "2", **params}, timeout=60)
    r.raise_for_status()
    time.sleep(0.3)
    return r.json().get("query", {})


def strip(t):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", t or ""))).strip()[:80]


def main():
    data = json.loads(SRC.read_text(encoding="utf-8"))
    s = requests.Session()
    s.headers["User-Agent"] = UA
    entries = [e for g in data.values() for e in g["entries"]]
    titles = [e["article"] for e in entries]
    lead = {}
    for i in range(0, len(titles), 20):
        q = get(s, action="query", titles="|".join(titles[i:i + 20]), redirects="1", prop="pageimages", piprop="name", pilicense="free")
        alias = {}
        for m in q.get("normalized", []) + q.get("redirects", []):
            alias[m["to"]] = alias.get(m["from"], m["from"])
        for p in q.get("pages", []):
            if p.get("pageimage"):
                lead[alias.get(p["title"], p["title"])] = p["pageimage"]
    files = sorted(set(lead.values()))
    info = {}
    for i in range(0, len(files), 40):
        q = get(s, action="query", titles="|".join("File:" + f.replace("_", " ") for f in files[i:i + 40]),
                prop="imageinfo", iiprop="url|extmetadata", iiurlwidth="640", iiextmetadatafilter="Artist|LicenseShortName")
        alias = {m["to"]: m["from"] for m in q.get("normalized", [])}
        for p in q.get("pages", []):
            ii = (p.get("imageinfo") or [None])[0]
            if not ii or not ii.get("thumburl"):
                continue
            meta = ii.get("extmetadata") if isinstance(ii.get("extmetadata"), dict) else {}
            lic = (meta.get("LicenseShortName") or {}).get("value", "")
            if not lic or NONFREE.search(lic):
                continue
            name = alias.get(p["title"], p["title"]).split(":", 1)[-1].replace(" ", "_")
            info[name] = {"u": ii["thumburl"], "by": strip((meta.get("Artist") or {}).get("value", "")) or "Unknown", "lic": lic}
    n = 0
    for e in entries:
        f = lead.get(e["article"])
        if f and f.replace(" ", "_") in info:
            e["img"] = info[f.replace(" ", "_")]
            n += 1
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(entries)} entries, {n} with a photo -> {OUT}")
    missing = [e["title"] for e in entries if "img" not in e]
    if missing:
        print("no photo:", ", ".join(missing))
    return 0


if __name__ == "__main__":
    sys.exit(main())
