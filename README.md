# ✈︎ Flight Window

See what's below your plane window, even in flight mode.

Save your flight before you board (e.g. BLR → DEL). The app downloads the map along your route. In the air, your phone's GPS works without any signal, so Flight Window shows:

- your live position, altitude, ground speed, heading and arrival time
- the city or peak below you, and what's coming up on your **left** or **right**
- which side of the plane to sit on for the best view
- **Scan your boarding pass** (photo, screenshot or PDF): reads the IATA barcode on the phone to get airline, flight, route, date and seat, then works out your window side
- **3D views**: satellite imagery on real terrain, a chase camera, and a **Window view** that puts the camera at your seat, at your GPS altitude, looking out your side of the plane, framed by a cabin window and wing with blinking nav and strobe lights
- **Night mode**: glowing road networks, warm city light and black rivers drawn from OpenStreetMap data, like the view on a night flight
- **What you're flying over**: rivers you cross, national parks, tiger and biosphere reserves, mountain ranges and plateaus, state borders and the Tropic of Cancer, with a heads-up about a minute before each one
- Smooth 60 fps camera that glides between GPS fixes; real-time simulator (1×, 10×, 60×); tap the screen to hide all controls

## How it works

- **Installable PWA** (Vite + MapLibre GL) with a Workbox service worker for the app shell
- **OpenFreeMap** vector tiles; a custom MapLibre protocol serves tiles, fonts and sprites from Cache Storage first
- A **corridor download** along the great-circle route: wide at low zooms and detailed near the line and both airports
- Bundled **OurAirports** (3,245 airports) and **Natural Earth** (cities, peaks, landmarks) data
- **Simulate** mode to try a flight on the ground
- Boarding passes decoded with **zxing-wasm** (QR, Aztec, PDF417) and **pdf.js**; nothing leaves the device
- 3D: **Sentinel-2 cloudless** imagery (EOX), **AWS Terrain Tiles** (Terrarium) and **NASA Black Marble** night lights

## Run locally

```bash
npm install
npm run dev
```

Deploy: import the repo into Vercel (Vite preset, no settings needed).

## Data & credits

Map data © OpenStreetMap contributors, tiles by OpenFreeMap / OpenMapTiles. Airports from OurAirports (public domain). Airlines from OpenFlights (ODbL). Places, rivers, lakes, regions and states from Natural Earth (public domain). Satellite imagery: Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024), free for non-commercial use with attribution. Terrain: Mapzen / AWS Terrain Tiles. Night lights: NASA Black Marble.
