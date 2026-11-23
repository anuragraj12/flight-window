# Place pipeline: a learning guide

This folder builds the **place packs**: small JSON files listing the forts, rivers, parks, dams, cities and battlefields of India, each with a summary, a photo and a score. The app downloads only the packs its route crosses.

It is a classic **ETL** pipeline (Extract, Transform, Load), run by GitHub Actions. Read this alongside `build_places.py`; each section here matches a function there.

## How to run it

- **On GitHub (normal way):** Actions tab → *Build place packs* → *Run workflow*. Leave the box empty for all of India, or type a small area such as `77,28,78,29` (around Delhi) for a two-minute test. It also runs by itself on the 1st of every month and whenever this folder changes.
- **On your Mac:** `pip install requests`, then `python pipeline/build_places.py --bbox 77,28,78,29 --out /tmp/places`.
- **The offline test:** `python pipeline/test_pipeline.py` runs everything against fake replies, no internet needed.

Results land in `public/places/v1/` and the run report in `pipeline/out/report.md`. Open the report first after every run.

## Step 1: Extract (`extract`)

**Wikidata** is the database behind Wikipedia. Every thing in it is an *item* with an ID (the Taj Mahal is `Q9141`) and *statements* such as "instance of: mausoleum" (`P31`) and "coordinate location" (`P625`).

We ask it questions in **SPARQL**, a query language for this kind of linked data. The query in `BOX_QUERY` says: give me every item with coordinates inside this box, with its types, English and Hindi article titles, photo, population and number of language links.

**Try it yourself:** open [query.wikidata.org](https://query.wikidata.org), paste the query from the code, replace the `%(w)s`-style placeholders with `77`, `28`, `78`, `29` and `LIMIT %(limit)d` with `LIMIT 50`, and press run. Then click the map view.

Why boxes? One query for all of India would time out (the public service stops after 60 seconds). So we cut India into 2° squares. If a square is too dense (Delhi), it is split into four smaller squares, again and again if needed. This "divide when too big" idea is called **adaptive subdivision** and you will see it everywhere in maps.

## Step 2: Classify (`classify`, `pick_category`)

Wikidata has thousands of types: "hill fort", "Hindu temple", "gravity dam", "tiger reserve". We want eight categories. Instead of listing every type, we list a few **root classes** (`ROOTS`: fort, river, dam, national park…) and ask Wikidata which of our items' types are a *subclass* of a root, at any depth. In SPARQL that is `?cls wdt:P279* ?root`: the `*` means "follow subclass of zero or more times".

So "hill fort" → fort → historic, without us ever naming hill forts.

When a type matches several roots, `CATEGORY_ORDER` decides: a hill fort is both a fort and a hill, and historic wins.

**Guarding against mistakes:** each root has the label we expect. The pipeline fetches the real labels and the report lists any mismatch, so a typo in an ID shows up on the first run instead of silently mislabelling places.

## Step 3: Enrich (`real_links`, `wiki_summaries`, `image_credits`)

- **Notability.** The number of Wikipedia languages with an article is a free measure of fame. But some Wikipedias (Cebuano, Swedish, Waray…) are mostly written by bots from map databases, giving an obscure hill 20 "languages". `BOT_WIKIS` removes them before counting. This is a good example of cleaning a signal before trusting it.
- **Summary and photo.** The Wikipedia API returns intros for up to 20 articles per call (`exlimit`), so 5,000 places need 250 calls, not 5,000. **Batching** is the biggest speed trick in any pipeline that calls APIs.
- **Photo credit.** Every photo on Wikimedia has its own author and licence. We fetch both and skip any photo marked fair use or non-free, because those may not be reused in an app.

**Being polite to public APIs:** a clear `User-Agent` naming the project, one request at a time, a pause between calls, automatic retries with growing waits on errors (`Retry(backoff_factor=2)`), and `maxlag` so Wikipedia can tell us to back off when busy.

## Step 4: Score (`score`)

Each place gets 0 to 100:

```
notability = log(1 + languages) / log(1 + 60)      # 60+ languages = 1.0
score = 100 × notability × category weight × photo factor × summary factor
```

Why a **log**? Going from 1 to 10 languages matters far more than 50 to 60. A log scale squeezes the top and spreads the bottom. Cities blend in population on a log scale too.

This is the *static* score. In the app, phase 2 multiplies it by distance from the flight path, your window side and time of day to choose what to feature.

## Step 5: Load (`load`)

Places are grouped into **map tiles**: the same squares web maps use. At zoom 7 the world is 128 × 128 squares; over India each is about 300 km wide. A place's tile comes from its longitude and latitude with the Web Mercator formula in `tile_of`. The app computes the same tiles along the route and downloads only those files.

Each record is kept short (`n` name, `c` category, `k` kind, `s` score, `p` position, `x` summary, `img` photo) because people download these on airport Wi-Fi.

## GitHub Actions (`.github/workflows/places.yml`)

The workflow is a recipe GitHub runs on a fresh Linux machine: check out the code, install Python, run the offline test, run the pipeline, commit the results. Because the results are committed, Vercel redeploys and the packs go live with no extra step.

## Exercises

1. Run the Delhi test area from the Actions tab and open the report. Which place scored highest, and do you agree?
2. Add a root class (for example step wells, or tea plantations). Find its ID by searching on wikidata.org, add it to `ROOTS`, push, and check the report's root check.
3. Change `CATEGORY_WEIGHT` and see how the top 25 changes.
4. Harder: Wikipedia page views are a better fame signal than language links. Look up the Wikimedia pageviews API and think about how to batch it.
