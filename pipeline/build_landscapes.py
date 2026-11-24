#!/usr/bin/env python3
"""
Flight Companion: landscape (ecoregion) layer.

Every point on land in India lies inside one ecoregion: a natural region such as
"Narmada Valley dry deciduous forests" or "Thar desert". That gives the app
something true to say about the ground even when no famous place is near.

Source: RESOLVE Ecoregions 2017 (Dinerstein et al.), CC BY 4.0.
Steps: download the shapefile → keep the ecoregions that touch our area →
clip and simplify the shapes → add a short Wikipedia summary → write
public/data/eco.json (GeoJSON). Run: python pipeline/build_landscapes.py
"""
from __future__ import annotations

import io
import json
import re
import sys
import time
import zipfile
from pathlib import Path

import requests
import shapefile                       # pyshp: reads .shp without GDAL
from shapely.geometry import box, mapping, shape

URL = "https://storage.googleapis.com/teow2016/Ecoregions2017.zip"
UA = "FlightCompanion/0.1 (https://github.com/anuragraj12/flight-window)"
BBOX = (66.0, 5.0, 99.0, 38.0)          # same area as the place packs
TOLERANCE = 0.02                         # degrees, about 2 km: plenty for "what am I over"
MIN_AREA = 0.05                          # square degrees: drop slivers that only graze the box
OUT = Path("public/data/eco.json")


def log(msg: str) -> None:
    print(msg, flush=True)


def download() -> zipfile.ZipFile:
    log(f"downloading {URL}")
    r = requests.get(URL, headers={"User-Agent": UA}, timeout=600)
    r.raise_for_status()
    log(f"  {len(r.content) / 1e6:.0f} MB")
    return zipfile.ZipFile(io.BytesIO(r.content))


def read_shapes(z: zipfile.ZipFile):
    names = z.namelist()
    base = next(n[:-4] for n in names if n.lower().endswith(".shp"))
    files = {ext: io.BytesIO(z.read(base + ext)) for ext in (".shp", ".shx", ".dbf")}
    return shapefile.Reader(shp=files[".shp"], shx=files[".shx"], dbf=files[".dbf"], encoding="latin-1")


def round_coords(obj, nd=3):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(obj[0], nd), round(obj[1], nd)]
        return [round_coords(o, nd) for o in obj]
    return obj


def summaries(names: list[str]) -> dict[str, dict]:
    """Two-sentence intro for each ecoregion, from its Wikipedia article (same title as the name)."""
    out = {}
    s = requests.Session()
    s.headers["User-Agent"] = UA
    for i in range(0, len(names), 20):
        batch = names[i:i + 20]
        r = s.get("https://en.wikipedia.org/w/api.php", params={
            "action": "query", "format": "json", "formatversion": "2", "redirects": "1",
            "titles": "|".join(batch), "prop": "extracts", "exintro": "1", "explaintext": "1",
            "exsentences": "3", "exlimit": "20",
        }, timeout=60)
        r.raise_for_status()
        q = r.json().get("query", {})
        alias = {}
        for m in q.get("normalized", []) + q.get("redirects", []):
            alias[m["to"]] = alias.get(m["from"], m["from"])
        for p in q.get("pages", []):
            if p.get("missing") or not p.get("extract"):
                continue
            src = alias.get(p["title"], p["title"])
            text = re.sub(r"\s*\([^()]*\)", "", p["extract"])
            out[src] = {"x": re.sub(r"\s+", " ", text).strip()[:420], "wp": p["title"]}
        time.sleep(0.3)
    return out


def main() -> int:
    area = box(*BBOX)
    reader = read_shapes(download())
    fields = [f[0] for f in reader.fields[1:]]
    feats = []
    for sr in reader.iterShapeRecords():
        rec = dict(zip(fields, sr.record))
        name = (rec.get("ECO_NAME") or "").strip()
        if not name or name.lower() in ("rock and ice", "lake"):
            continue
        geom = shape(sr.shape.__geo_interface__)
        if not geom.is_valid:
            geom = geom.buffer(0)
        if not geom.intersects(area):
            continue
        clipped = geom.intersection(area)
        if clipped.is_empty or clipped.area < MIN_AREA:
            continue
        simple = clipped.simplify(TOLERANCE, preserve_topology=True)
        if simple.is_empty:
            continue
        feats.append({
            "type": "Feature",
            "properties": {"id": int(rec.get("ECO_ID") or 0), "name": name,
                           "biome": rec.get("BIOME_NAME") or "", "realm": rec.get("REALM") or ""},
            "geometry": {"type": mapping(simple)["type"], "coordinates": round_coords(mapping(simple)["coordinates"])},
        })
    log(f"{len(feats)} ecoregions in the area")

    info = summaries(sorted({f["properties"]["name"] for f in feats}))
    for f in feats:
        f["properties"].update(info.get(f["properties"]["name"], {}))
    log(f"{len(info)} have a Wikipedia summary")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps({"type": "FeatureCollection", "credit": "RESOLVE Ecoregions 2017 (CC BY 4.0); text from Wikipedia (CC BY-SA)",
                       "features": feats}, ensure_ascii=False, separators=(",", ":"))
    OUT.write_text(body, encoding="utf-8")
    log(f"wrote {OUT} ({len(body) / 1e6:.2f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
