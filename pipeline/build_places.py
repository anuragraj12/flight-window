#!/usr/bin/env python3
"""
Flight Companion: place-pack pipeline (Phase 1).

Builds small JSON "place packs" for India, one per map tile, that the app
downloads for the tiles a route crosses. Five steps, each a function below:

  1. extract   Wikidata: every item with coordinates, box by box (SPARQL)
  2. classify  map each item's type ("instance of") to one of our categories
  3. enrich    real language-link counts, Wikipedia summary + photo + credit
  4. score     a 0-100 notability score per place
  5. load      write one file per tile, an index, and a run report

Read pipeline/README.md alongside this file: it explains each idea.
Run:  python pipeline/build_places.py --out public/places
"""
from __future__ import annotations

import argparse
import html
import json
import math
import re
import sys
import time
import traceback
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

# ---------------------------------------------------------------- settings
UA = ("FlightCompanion/0.1 (https://github.com/anuragraj12/flight-window; "
      "place packs for an offline flight map)")
WDQS = "https://query.wikidata.org/sparql"
WIKI_API = "https://en.wikipedia.org/w/api.php"

# India plus a margin of roughly 150 km: west, south, east, north (degrees)
BBOX = (66.0, 5.0, 99.0, 38.0)
START_STEP = 2.0        # first try 2 x 2 degree boxes...
MIN_STEP = 0.25         # ...split dense ones down to 0.25 degrees
ROW_LIMIT = 8000        # more rows than this in one box -> split it
TILE_Z = 7              # pack tiles: zoom 7 is about 300 km across over India
MIN_SCORE = 6           # drop places scoring below this

# Our categories, in priority order: when an item matches several (a hill
# fort is both a fort and a hill), the first one in this list wins.
CATEGORY_ORDER = ["exclude", "historic", "battle", "nature", "water", "terrain", "city", "works"]

# Root classes. Anything whose type is this class, or a subclass of it at any
# depth, belongs to the category. The label is what we expect Wikidata to call
# the class; the report warns if it does not match, which catches typos in IDs.
ROOTS: dict[str, tuple[str, str]] = {
    # water
    "Q4022": ("river", "water"),
    "Q23397": ("lake", "water"),
    "Q131681": ("reservoir", "water"),
    "Q34038": ("waterfall", "water"),
    "Q39594": ("bay", "water"),
    "Q187223": ("lagoon", "water"),
    "Q170321": ("wetland", "water"),
    "Q23442": ("island", "water"),
    # terrain
    "Q8502": ("mountain", "terrain"),
    "Q46831": ("mountain range", "terrain"),
    "Q54050": ("hill", "terrain"),
    "Q75520": ("plateau", "terrain"),
    "Q39816": ("valley", "terrain"),
    "Q35666": ("glacier", "terrain"),
    "Q8514": ("desert", "terrain"),
    "Q133056": ("mountain pass", "terrain"),
    "Q8072": ("volcano", "terrain"),
    "Q35509": ("cave", "terrain"),
    "Q150784": ("canyon", "terrain"),
    "Q40080": ("beach", "terrain"),
    # nature
    "Q46169": ("national park", "nature"),
    "Q158454": ("biosphere reserve", "nature"),
    "Q179049": ("nature reserve", "nature"),
    "Q473972": ("protected area", "nature"),
    "Q4421": ("forest", "nature"),
    # works (big human-made structures)
    "Q12323": ("dam", "works"),
    "Q12280": ("bridge", "works"),
    "Q159719": ("power station", "works"),
    "Q44782": ("port", "works"),
    "Q12284": ("canal", "works"),
    "Q39715": ("lighthouse", "works"),
    "Q1248784": ("airport", "works"),
    # historic
    "Q1785071": ("fort", "historic"),
    "Q23413": ("castle", "historic"),
    "Q16560": ("palace", "historic"),
    "Q839954": ("archaeological site", "historic"),
    "Q44539": ("temple", "historic"),
    "Q32815": ("mosque", "historic"),
    "Q16970": ("church building", "historic"),
    "Q44613": ("monastery", "historic"),
    "Q180987": ("stupa", "historic"),
    "Q162875": ("mausoleum", "historic"),
    "Q4989906": ("monument", "historic"),
    "Q109607": ("ruins", "historic"),
    # battle
    "Q178561": ("battle", "battle"),
    # settlements: kept only when large (see keep())
    "Q486972": ("human settlement", "city"),
    # never shown: whole countries are not "places along the route"
    "Q6256": ("country", "exclude"),
}

# How much each category counts when ranking (1.0 = full weight)
CATEGORY_WEIGHT = {"water": 1.0, "terrain": 1.0, "nature": 1.0, "city": 1.0,
                   "historic": 0.9, "works": 0.8, "battle": 0.6}

# Some kinds are less interesting from a window than their category suggests
KIND_WEIGHT = {"airport": 0.5, "power station": 0.6, "church building": 0.8,
               "mosque": 0.85, "temple": 0.85}
WORLD_HERITAGE = "Q9259"  # UNESCO World Heritage Site

# Wikipedias written mostly by bots from map databases. They give rivers and
# hills dozens of "language links" that say nothing about real notability.
BOT_WIKIS = {"ceb", "sv", "war", "arz", "azb", "uz", "vi", "nl", "sh", "sr"}


# ---------------------------------------------------------------- network
class Net:
    """All network access goes through here, so tests can swap it out."""

    def __init__(self) -> None:
        import requests
        from requests.adapters import HTTPAdapter
        from urllib3.util.retry import Retry
        self.s = requests.Session()
        self.s.headers["User-Agent"] = UA
        retry = Retry(total=5, backoff_factor=2,
                      status_forcelist=(429, 500, 502, 503, 504),
                      allowed_methods=("GET", "POST"))
        self.s.mount("https://", HTTPAdapter(max_retries=retry))
        self.calls = Counter()

    def sparql(self, query: str) -> list[dict]:
        self.calls["sparql"] += 1
        r = self.s.post(WDQS, data={"query": query, "format": "json"},
                        headers={"Accept": "application/sparql-results+json"},
                        timeout=90)
        r.raise_for_status()
        time.sleep(1.0)  # be polite: one query at a time, a pause between
        return r.json()["results"]["bindings"]

    def wiki(self, params: dict) -> dict:
        self.calls["wiki"] += 1
        p = {"format": "json", "formatversion": "2", "maxlag": "5", **params}
        r = self.s.get(WIKI_API, params=p, timeout=60)
        r.raise_for_status()
        time.sleep(0.2)
        return r.json()


def val(b: dict, k: str):
    return b[k]["value"] if k in b else None


def chunks(seq, n):
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


# ---------------------------------------------------------------- 1. extract
BOX_QUERY = """
SELECT ?item (SAMPLE(?coord) AS ?c) (MAX(?sl) AS ?links)
       (SAMPLE(?enTitle) AS ?en) (SAMPLE(?hiTitle) AS ?hi)
       (SAMPLE(?img) AS ?image) (MAX(?pop) AS ?population)
       (SAMPLE(?lab) AS ?label) (SAMPLE(?desc) AS ?description)
       (MAX(?isWhs) AS ?whs)
       (GROUP_CONCAT(DISTINCT ?clsId; separator=" ") AS ?classes)
WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(%(w)s %(s)s)"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(%(e)s %(n)s)"^^geo:wktLiteral .
  }
  ?item wikibase:sitelinks ?sl . FILTER(?sl >= 2)
  ?item wdt:P31 ?cls . BIND(STRAFTER(STR(?cls), "entity/") AS ?clsId)
  OPTIONAL { ?enA schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?enTitle . }
  OPTIONAL { ?hiA schema:about ?item ; schema:isPartOf <https://hi.wikipedia.org/> ; schema:name ?hiTitle . }
  OPTIONAL { ?item wdt:P18 ?img }
  OPTIONAL { ?item wdt:P1082 ?pop }
  OPTIONAL { ?item wdt:P1435 wd:%(whs)s . BIND(1 AS ?isWhs) }
  OPTIONAL { ?item rdfs:label ?lab FILTER(LANG(?lab) = "en") }
  OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc) = "en") }
}
GROUP BY ?item
LIMIT %(limit)d
"""

POINT = re.compile(r"Point\(([-\d.eE]+) ([-\d.eE]+)\)")


def parse_item(b: dict) -> dict | None:
    m = POINT.search(val(b, "c") or "")
    if not m:
        return None
    pop = val(b, "population")
    return {
        "id": val(b, "item").rsplit("/", 1)[-1],
        "lon": float(m.group(1)), "lat": float(m.group(2)),
        "links": int(val(b, "links") or 0),
        "en": val(b, "en"), "hi": val(b, "hi"),
        "image": unquote(val(b, "image").rsplit("/", 1)[-1]) if val(b, "image") else None,
        "pop": int(float(pop)) if pop else 0,
        "label": val(b, "label"), "desc": val(b, "description"),
        "classes": (val(b, "classes") or "").split(),
        "whs": val(b, "whs") == "1",
    }


def extract(net: Net, log, bbox=BBOX, step=START_STEP) -> dict[str, dict]:
    """Query every box in the area; split a box into four if it is too dense."""
    w0, s0, e0, n0 = bbox
    todo = []
    lat = s0
    while lat < n0:
        lon = w0
        while lon < e0:
            todo.append((lon, lat, min(lon + step, e0), min(lat + step, n0)))
            lon += step
        lat += step

    items: dict[str, dict] = {}
    stats = Counter()
    while todo:
        w, s, e, n = todo.pop(0)
        size = e - w
        q = BOX_QUERY % {"w": w, "s": s, "e": e, "n": n, "limit": ROW_LIMIT + 1, "whs": WORLD_HERITAGE}
        try:
            rows = net.sparql(q)
        except Exception as ex:  # timeouts on dense boxes
            if size / 2 >= MIN_STEP:
                log(f"  box {w},{s} size {size}: {type(ex).__name__}, splitting")
                todo[:0] = quarter(w, s, e, n)
                stats["split"] += 1
            else:
                log(f"  box {w},{s} size {size}: FAILED {ex}")
                stats["failed"] += 1
            continue
        if len(rows) > ROW_LIMIT and size / 2 >= MIN_STEP:
            todo[:0] = quarter(w, s, e, n)
            stats["split"] += 1
            continue
        for b in rows:
            it = parse_item(b)
            if it:
                items[it["id"]] = it
        stats["boxes"] += 1
        if stats["boxes"] % 20 == 0:
            log(f"  {stats['boxes']} boxes done, {len(items)} items, {len(todo)} to go")
    log(f"extract: {len(items)} items from {stats['boxes']} boxes "
        f"({stats['split']} splits, {stats['failed']} failed)")
    return items


def quarter(w, s, e, n):
    mx, my = (w + e) / 2, (s + n) / 2
    return [(w, s, mx, my), (mx, s, e, my), (w, my, mx, n), (mx, my, e, n)]


# ---------------------------------------------------------------- 2. classify
CLASS_QUERY = """
SELECT ?cls ?root WHERE {
  VALUES ?cls { %s }
  VALUES ?root { %s }
  ?cls wdt:P279* ?root .
}
"""

LABEL_QUERY = """
SELECT ?root ?label WHERE {
  VALUES ?root { %s }
  ?root rdfs:label ?label FILTER(LANG(?label) = "en")
}
"""


def check_roots(net: Net) -> list[str]:
    """Compare each root's real Wikidata label with the one we expect."""
    rows = net.sparql(LABEL_QUERY % " ".join(f"wd:{q}" for q in ROOTS))
    got = {val(b, "root").rsplit("/", 1)[-1]: val(b, "label") for b in rows}
    warnings = []
    for q, (want, _) in ROOTS.items():
        if got.get(q, "").lower() != want.lower():
            warnings.append(f"{q}: expected '{want}', Wikidata says '{got.get(q)}'")
    return warnings


def classify(net: Net, items: dict[str, dict], log) -> dict[str, list[str]]:
    """Return {class id: [root ids]} for every class used by an item."""
    classes = sorted({c for it in items.values() for c in it["classes"]})
    roots_v = " ".join(f"wd:{q}" for q in ROOTS)
    found: dict[str, list[str]] = defaultdict(list)
    for batch in chunks(classes, 150):
        q = CLASS_QUERY % (" ".join(f"wd:{c}" for c in batch), roots_v)
        try:
            rows = net.sparql(q)
        except Exception as ex:
            log(f"  class batch failed ({ex}); retrying in halves")
            rows = []
            for half in chunks(batch, 50):
                rows += net.sparql(CLASS_QUERY % (" ".join(f"wd:{c}" for c in half), roots_v))
        for b in rows:
            found[val(b, "cls").rsplit("/", 1)[-1]].append(val(b, "root").rsplit("/", 1)[-1])
    log(f"classify: {len(classes)} distinct types, {len(found)} map to a category")
    return found


def pick_category(it: dict, class_roots: dict[str, list[str]]):
    """Choose the highest-priority category and the root label that gave it."""
    best = None
    for c in it["classes"]:
        for root in class_roots.get(c, []):
            label, cat = ROOTS[root]
            rank = CATEGORY_ORDER.index(cat)
            # within a category, prefer the most specific label (direct match)
            exact = 0 if c == root else 1
            key = (rank, exact)
            if best is None or key < best[0]:
                best = (key, cat, label)
    if not best:
        return None, None
    return best[1], ("city" if best[1] == "city" else best[2])


def keep(it: dict) -> bool:
    """First filter, before any Wikipedia calls."""
    if it["cat"] in (None, "exclude") or not it.get("label"):
        return False
    if it["cat"] == "city":
        return it["pop"] >= 100_000 or it["links"] >= 40
    # needs an English article or a decent number of language links
    return bool(it["en"]) or it["links"] >= 5


# ---------------------------------------------------------------- 3. enrich
LINKS_QUERY = """
SELECT ?item ?wiki WHERE {
  VALUES ?item { %s }
  ?a schema:about ?item ; schema:isPartOf ?wiki .
  FILTER(CONTAINS(STR(?wiki), ".wikipedia.org"))
}
"""


def real_links(net: Net, items: list[dict], log) -> None:
    """Count language links, ignoring bot-written Wikipedias."""
    for batch in chunks(items, 300):
        rows = net.sparql(LINKS_QUERY % " ".join(f"wd:{it['id']}" for it in batch))
        n = Counter()
        for b in rows:
            lang = val(b, "wiki").split("//", 1)[-1].split(".", 1)[0]
            if lang not in BOT_WIKIS:
                n[val(b, "item").rsplit("/", 1)[-1]] += 1
        for it in batch:
            it["langs"] = n.get(it["id"], 0)
    log(f"real_links: counted for {len(items)} places")


def wiki_summaries(net: Net, items: list[dict], log) -> None:
    """Short intro text, description and lead photo from English Wikipedia."""
    by_title = {it["en"]: it for it in items if it["en"]}
    for batch in chunks(by_title, 20):  # the extracts API allows 20 per call
        data = net.wiki({
            "action": "query", "titles": "|".join(batch), "redirects": "1",
            "prop": "extracts|pageimages|description",
            "exintro": "1", "explaintext": "1", "exsentences": "3", "exlimit": "20",
            "piprop": "name", "pilicense": "free",
        })
        q = data.get("query", {})
        alias = {}
        for m in q.get("normalized", []) + q.get("redirects", []):
            alias[m["to"]] = alias.get(m["from"], m["from"])
        for page in q.get("pages", []):
            src = alias.get(page.get("title"), page.get("title"))
            it = by_title.get(src)
            if not it or page.get("missing"):
                continue
            it["extract"] = clean_extract(page.get("extract", ""))
            if page.get("description"):
                it["desc"] = page["description"]
            if page.get("pageimage"):
                it["image"] = page["pageimage"]  # Wikipedia's lead photo wins
    log(f"wiki_summaries: {len(by_title)} articles")


def clean_extract(t: str, limit: int = 360) -> str:
    t = re.sub(r"\s*\([^()]*\)", "", t)          # drop (pronunciation; dates)
    t = re.sub(r"\s+", " ", t).strip()
    if len(t) <= limit:
        return t
    cut = t[:limit]
    end = cut.rfind(". ")
    return cut[:end + 1] if end > 120 else cut.rsplit(" ", 1)[0] + "…"


NONFREE = re.compile(r"fair use|non-free|copyrighted", re.I)


def image_credits(net: Net, items: list[dict], log) -> None:
    """Thumbnail URL plus author and licence for every photo we will show."""
    by_file: dict[str, list[dict]] = defaultdict(list)
    for it in items:
        if it.get("image"):
            by_file[it["image"].replace("_", " ")].append(it)
    ok = 0
    for batch in chunks(by_file, 50):
        data = net.wiki({
            "action": "query", "titles": "|".join("File:" + f for f in batch),
            "prop": "imageinfo", "iiprop": "url|extmetadata", "iiurlwidth": "480",
            "iiextmetadatafilter": "Artist|LicenseShortName|LicenseUrl",
        })
        q = data.get("query", {})
        alias = {m["to"]: m["from"] for m in q.get("normalized", [])}
        for page in q.get("pages", []):
            title = alias.get(page.get("title"), page.get("title", ""))
            name = title.split(":", 1)[-1]
            info = (page.get("imageinfo") or [None])[0]
            if not info or not info.get("thumburl"):
                continue
            meta = info.get("extmetadata", {})
            lic = meta.get("LicenseShortName", {}).get("value", "")
            if not lic or NONFREE.search(lic):
                continue
            img = {
                "u": info["thumburl"], "w": info.get("thumbwidth"), "h": info.get("thumbheight"),
                "by": strip_html(meta.get("Artist", {}).get("value", "")) or "Unknown",
                "lic": lic, "src": info.get("descriptionurl"),
            }
            for it in by_file.get(name, []):
                it["img"] = img
                ok += 1
    log(f"image_credits: {ok} places have a usable photo")


def strip_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\s+", " ", html.unescape(s)).strip()[:80]


# ---------------------------------------------------------------- 4. score
def score(it: dict) -> int:
    """0-100. Language links on a log scale, times weights for kind and content."""
    langs = it.get("langs", it["links"])
    notability = min(1.0, math.log1p(langs) / math.log1p(200))   # 200 languages = 1.0
    if it["cat"] == "city":  # cities: blend in population, 100k -> 0.3, 10M -> 0.9
        pop = min(1.0, max(0.0, (math.log10(max(it["pop"], 1)) - 4) / 3.3))
        notability = max(notability, pop)
    weight = CATEGORY_WEIGHT[it["cat"]] * KIND_WEIGHT.get(it["kind"], 1.0)
    photo = 1.0 if it.get("img") else 0.8
    text = 1.0 if it.get("extract") else 0.85
    unesco = 1.25 if it.get("whs") else 1.0
    return round(100 * min(1.0, notability * weight * photo * text * unesco))


# ---------------------------------------------------------------- 5. load
def tile_of(lon: float, lat: float, z: int = TILE_Z) -> tuple[int, int]:
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    r = math.radians(lat)
    y = int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n)
    return x, y


def display_name(it: dict) -> str:
    """Wikipedia's title is better checked than Wikidata's label: use it, minus
    "(disambiguation)" and ", State" endings (Jaura, Madhya Pradesh -> Jaura)."""
    if not it.get("en"):
        return it["label"]
    t = re.sub(r"\s*\(.*?\)$", "", it["en"]).split(", ")[0].strip()
    return t or it["label"]


def record(it: dict) -> dict:
    r = {"id": it["id"], "n": display_name(it), "c": it["cat"], "k": it["kind"],
         "s": it["score"], "p": [round(it["lon"], 4), round(it["lat"], 4)]}
    if it.get("hi"):
        r["hi"] = it["hi"]
    if it.get("whs"):
        r["u"] = 1  # UNESCO World Heritage Site
    if it.get("desc"):
        r["d"] = it["desc"][:120]
    if it.get("extract"):
        r["x"] = it["extract"]
    if it.get("img"):
        r["img"] = it["img"]
    if it.get("en"):
        r["wp"] = it["en"]
    return r


def load(places: list[dict], out: Path, log) -> dict:
    tiles: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for it in places:
        tiles[tile_of(it["lon"], it["lat"])].append(record(it))
    tdir = out / "v1" / str(TILE_Z)
    if tdir.exists():
        for f in tdir.rglob("*.json"):
            f.unlink()
    tdir.mkdir(parents=True, exist_ok=True)
    index_tiles = {}
    total = 0
    for (x, y), recs in sorted(tiles.items()):
        recs.sort(key=lambda r: -r["s"])
        p = tdir / f"{x}-{y}.json"
        body = json.dumps(recs, ensure_ascii=False, separators=(",", ":"))
        p.write_text(body, encoding="utf-8")
        index_tiles[f"{x}-{y}"] = {"n": len(recs), "kb": round(len(body.encode()) / 1024, 1)}
        total += len(body.encode())
    index = {
        "version": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "z": TILE_Z, "path": f"v1/{TILE_Z}/{{x}}-{{y}}.json",
        "count": len(places), "kb": round(total / 1024),
        "categories": dict(Counter(p["cat"] for p in places).most_common()),
        "tiles": index_tiles,
        "credits": ["Wikidata (CC0)", "Wikipedia (CC BY-SA 4.0)",
                    "Photos: Wikimedia Commons, credited per photo"],
    }
    (out / "v1" / "index.json").write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    log(f"load: {len(places)} places in {len(tiles)} tiles, {total / 1e6:.1f} MB")
    return index


# ---------------------------------------------------------------- run
def run(net: Net, out: Path, report_path: Path, bbox=BBOX) -> int:
    t0 = time.time()
    lines: list[str] = []

    def log(msg: str) -> None:
        stamp = f"[{time.time() - t0:6.0f}s] {msg}"
        print(stamp, flush=True)
        lines.append(stamp)

    warnings = check_roots(net)
    for w in warnings:
        log(f"ROOT WARNING {w}")

    items = extract(net, log, bbox)
    class_roots = classify(net, items, log)
    for it in items.values():
        it["cat"], it["kind"] = pick_category(it, class_roots)
    cands = [it for it in items.values() if keep(it)]
    log(f"filter: {len(cands)} candidates of {len(items)}")

    real_links(net, cands, log)
    cands = [it for it in cands if it["en"] or it["langs"] >= 4]
    wiki_summaries(net, cands, log)
    image_credits(net, cands, log)

    for it in cands:
        it["score"] = score(it)
    places = [it for it in cands if it["score"] >= MIN_SCORE]
    index = load(places, out, log)

    write_report(report_path, index, places, warnings, lines, net, time.time() - t0)
    return 0


def write_report(path: Path, index: dict, places: list[dict], warnings, lines, net, secs) -> None:
    top = sorted(places, key=lambda p: -p["score"])[:25]
    per_cat_top = defaultdict(list)
    for p in sorted(places, key=lambda p: -p["score"]):
        if len(per_cat_top[p["cat"]]) < 5:
            per_cat_top[p["cat"]].append(p)
    md = [f"# Place pack report, {index['version']}", "",
          f"- Places: **{index['count']}** in {len(index['tiles'])} tiles, {index['kb']} KB of JSON",
          f"- Time: {secs / 60:.1f} min; calls: {dict(net.calls)}",
          f"- With photo: {sum(1 for p in places if p.get('img'))}, "
          f"with summary: {sum(1 for p in places if p.get('extract'))}, "
          f"UNESCO sites: {sum(1 for p in places if p.get('whs'))}", "",
          "Score spread: " + " ".join(f"{lo}-{lo + 9}: {sum(1 for p in places if lo <= p['score'] < lo + 10)}"
                                      for lo in range(0, 100, 10)) + f" 100: {sum(1 for p in places if p['score'] == 100)}", "",
          "## Categories", ""]
    md += [f"- {c}: {n}" for c, n in index["categories"].items()]
    md += ["", "## Root class check", ""]
    md += [f"- {w}" for w in warnings] or ["- All root labels match."]
    md += ["", "## Top 25", "", "| Score | Place | Kind | Langs | Photo |", "|---|---|---|---|---|"]
    md += [f"| {p['score']} | {p['label']} | {p['kind']} | {p.get('langs')} | {'yes' if p.get('img') else ''} |"
           for p in top]
    md += ["", "## Top 5 per category", ""]
    for c, ps in per_cat_top.items():
        md.append(f"- **{c}**: " + ", ".join(f"{p['label']} ({p['score']})" for p in ps))
    md += ["", "## Log", "", "```", *lines, "```", ""]
    path.write_text("\n".join(md), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/places")
    ap.add_argument("--report", default="pipeline/out/report.md")
    ap.add_argument("--bbox", help="w,s,e,n for a quick test run, e.g. 77,28,78,29")
    a = ap.parse_args()
    out, rep = Path(a.out), Path(a.report)
    out.mkdir(parents=True, exist_ok=True)
    rep.parent.mkdir(parents=True, exist_ok=True)
    bbox = tuple(float(v) for v in a.bbox.split(",")) if a.bbox else BBOX
    try:
        return run(Net(), out, rep, bbox)
    except Exception:
        rep.write_text("# Pipeline failed\n\n```\n" + traceback.format_exc() + "```\n", encoding="utf-8")
        raise


if __name__ == "__main__":
    sys.exit(main())
