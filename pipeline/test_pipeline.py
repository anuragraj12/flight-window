"""Offline test: runs the whole pipeline against fake Wikidata/Wikipedia replies.
Run: python pipeline/test_pipeline.py
"""
import json
import sys
import tempfile
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_places as bp  # noqa: E402

E = "http://www.wikidata.org/entity/"


def b(**kw):
    return {k: {"value": str(v)} for k, v in kw.items() if v is not None}


ITEMS = [
    # id, lon, lat, links, en, classes, extra
    ("Q1", 76.6, 26.8, 40, "Ranthambore Fort", "Q1785071 Q54050", {}),          # fort on a hill -> historic
    ("Q2", 78.0, 22.5, 60, "Narmada River", "Q4022", {}),
    ("Q3", 77.2, 28.6, 200, "Delhi", "Q1549591", {"population": 16000000}),       # big city -> subclass of settlement
    ("Q4", 77.5, 28.4, 3, None, "Q532", {"population": 2000}),                  # village -> dropped
    ("Q5", 76.5, 15.3, 30, "Tungabhadra Dam", "Q12323", {}),
    ("Q6", 80.0, 21.0, 2, None, "Q999", {}),                                    # unknown type -> dropped
    ("Q7", 76.5, 11.5, 25, "Nagarhole National Park", "Q46169", {"image": "http://commons.wikimedia.org/wiki/Special:FilePath/Nag%20park.jpg"}),
    ("Q8", 76.4, 29.9, 12, "Battle of Panipat", "Q178561", {}),
    ("Q9", 80.7, 25.0, 90, "Somewhere Country", "Q3624078 Q23442", {}),      # country -> excluded
    ("Q10", 78.0, 27.2, 150, "Taj Mahal", "Q162875", {"whs": 1}),
]
SUBCLASS = {"Q1549591": ["Q486972"], "Q532": ["Q486972"], "Q3624078": ["Q6256"]}  # big city, village


class FakeNet:
    def __init__(self):
        self.calls = Counter()
        self.box_calls = 0

    def sparql(self, q):
        self.calls["sparql"] += 1
        if "rdfs:label ?label" in q and "VALUES ?root" in q and "P279" not in q:
            return [b(root=E + k, label=v[0]) for k, v in bp.ROOTS.items() if k != "Q4421"] + \
                   [b(root=E + "Q4421", label="woodland")]  # simulate one wrong label
        if "wikibase:box" in q:
            self.box_calls += 1
            if self.box_calls == 1:
                raise TimeoutError("simulated timeout")    # first box splits
            import re
            w, s = map(float, re.search(r'cornerSouthWest "Point\(([-\d.]+) ([-\d.]+)\)', q).groups())
            e, n = map(float, re.search(r'cornerNorthEast "Point\(([-\d.]+) ([-\d.]+)\)', q).groups())
            out = []
            for qid, lon, lat, links, en, cls, extra in ITEMS:
                if w <= lon < e and s <= lat < n:
                    out.append(b(item=E + qid, c=f"Point({lon} {lat})", links=links, en=en,
                                 label=en or qid, classes=cls, **extra))
            return out
        if "P279*" in q:
            out = []
            import re
            classes = re.findall(r"wd:(Q\d+)", q.split("VALUES ?root")[0])
            for c in classes:
                for r in [c] + SUBCLASS.get(c, []):
                    if r in bp.ROOTS:
                        out.append(b(cls=E + c, root=E + r))
            return out
        if "schema:isPartOf ?wiki" in q:
            import re
            out = []
            for qid in re.findall(r"wd:(Q\d+)", q):
                links = next(i[3] for i in ITEMS if i[0] == qid)
                for k in range(links):
                    lang = ["en", "hi", "ceb", "sv", "ta", "fr"][k % 6] + str(k)
                    if k < 2:
                        lang = ["ceb", "sv"][k]
                    out.append(b(item=E + qid, wiki=f"https://{lang}.wikipedia.org/"))
            return out
        raise AssertionError("unexpected query: " + q[:80])

    def wiki(self, p):
        self.calls["wiki"] += 1
        if p.get("prop", "").startswith("extracts"):
            titles = p["titles"].split("|")
            pages = []
            for t in titles:
                page = {"title": t, "extract": f"{t} (pronounced x) is notable. It is in India. More text here.",
                        "description": f"desc of {t}"}
                if t != "Battle of Panipat":
                    page["pageimage"] = t.replace(" ", "_") + ".jpg"
                pages.append(page)
            return {"query": {"pages": pages}}
        if p.get("prop") == "imageinfo":
            pages = []
            for t in p["titles"].split("|"):
                lic = "Fair use" if "Dam" in t else "CC BY-SA 4.0"
                if "Ranthambore" in t:  # the real API sometimes sends [] here
                    pages.append({"title": t, "imageinfo": [{"thumburl": "https://x/y.jpg", "extmetadata": []}]})
                    continue
                pages.append({"title": t, "imageinfo": [{
                    "thumburl": "https://upload.wikimedia.org/x/480px-" + t[5:], "thumbwidth": 480,
                    "thumbheight": 320, "descriptionurl": "https://commons.wikimedia.org/wiki/" + t,
                    "extmetadata": {"LicenseShortName": {"value": lic},
                                    "Artist": {"value": '<a href="x">Some &amp; One</a>'}}}]})
            return {"query": {"pages": pages}}
        raise AssertionError(p)


def main():
    with tempfile.TemporaryDirectory() as d:
        out, rep = Path(d) / "places", Path(d) / "report.md"
        out.mkdir()
        bp.run(FakeNet(), out, rep, bbox=(74.0, 10.0, 82.0, 30.0))
        idx = json.loads((out / "v1" / "index.json").read_text())
        allp = {}
        for name in idx["tiles"]:
            for r in json.loads((out / "v1" / "7" / f"{name}.json").read_text()):
                allp[r["id"]] = r
        report = rep.read_text()

        assert set(allp) == {"Q1", "Q2", "Q3", "Q5", "Q7", "Q8", "Q10"}, allp.keys()
        assert allp["Q1"]["c"] == "historic" and allp["Q1"]["k"] == "fort"
        assert allp["Q3"]["c"] == "city" and allp["Q3"]["k"] == "city"
        assert allp["Q5"]["c"] == "works" and "img" not in allp["Q5"], "fair-use photo must be skipped"
        assert allp["Q7"]["img"]["by"] == "Some & One"
        assert "img" not in allp["Q1"], "photo without licence info must be skipped"
        assert allp["Q10"]["u"] == 1 and "u" not in allp["Q1"]
        assert "(pronounced" not in allp["Q2"]["x"]
        assert "Q4421" in report and "woodland" in report, "root label warning missing"
        assert "splitting" in report
        # sorted by score inside each tile
        for name in idx["tiles"]:
            recs = json.loads((out / "v1" / "7" / f"{name}.json").read_text())
            assert [r["s"] for r in recs] == sorted([r["s"] for r in recs], reverse=True)
        assert bp.display_name({"en": "Jaura, Madhya Pradesh", "label": "Jaura"}) == "Jaura"
        assert bp.display_name({"en": "Keoladeo National Park", "label": "Kevladev National Park"}) == "Keoladeo National Park"
        assert bp.display_name({"en": "Kaveri (river)", "label": "x"}) == "Kaveri"
        assert bp.tile_of(77.2, 28.6) == (91, 53), bp.tile_of(77.2, 28.6)
        print("scores:", {k: v["s"] for k, v in allp.items()})
        print("categories:", idx["categories"])
        print("OK")


if __name__ == "__main__":
    main()
