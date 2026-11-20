# ✈︎ Flight Window

See what's below your plane window, even in flight mode.

Save your flight before you board (e.g. BLR → DEL). The app downloads the map along your route. In the air, your phone's GPS works without any signal, so Flight Window shows:

- your live position, altitude, ground speed, heading and arrival time
- the city or peak below you, and what's coming up on your **left** or **right**
- which side of the plane to sit on for the best view

## How it works

- **Installable PWA** (Vite + MapLibre GL) with a Workbox service worker for the app shell
- **OpenFreeMap** vector tiles; a custom MapLibre protocol serves tiles, fonts and sprites from Cache Storage first
- A **corridor download** along the great-circle route: wide at low zooms and detailed near the line and both airports
- Bundled **OurAirports** (3,245 airports) and **Natural Earth** (cities, peaks, landmarks) data
- **Simulate** mode to try a flight on the ground

## Run locally

```bash
npm install
npm run dev
```

Deploy: import the repo into Vercel (Vite preset, no settings needed).

## Data & credits

Map data © OpenStreetMap contributors, tiles by OpenFreeMap / OpenMapTiles. Airports from OurAirports (public domain). Places from Natural Earth (public domain).
