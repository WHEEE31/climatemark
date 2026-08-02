# ClimateMark

Climate risk for a specific property, where **every number carries its own provenance**.

Most risk scores hide how they were made. ClimateMark stamps each hazard `Measured`,
`Modeled`, or `Estimated`, leads with the single hazard that should drive your decision,
and withholds the combined score entirely when the evidence can't carry it.

No API keys. No database. No accounts.

---

## Run it

```bash
npm install
npm run dev
```

Open **http://localhost:5000**. One command, one port, one URL — Vite runs inside the
Express process, so there's no proxy to configure and no second terminal.

### Demo mode

**Try a sample property** loads a curated address with property details already filled in.
Each of the eight samples is chosen to land on a *different* dominant hazard, so clicking
it repeatedly shows the assessment responding to location rather than returning a
house-shaped average. Two are worth knowing for a live demo:

- **Paradise, CA** — wood shake roof in a high wildfire zone. Roof replacement jumps to
  the top of the actions list, labelled *From your property details*.
- **Milan, Italy** — outside US hazard-layer coverage. The confidence stamps drop to
  `Estimated` and the combined score is withheld entirely, which demonstrates the core
  design argument in one click.

Samples are public civic and commercial addresses, not private residences. Edit them in
`src/lib/samples.ts`.

## Test the production build

```bash
npm run build
npm run smoke
```

`npm run smoke` boots the real build and checks that it serves traffic, rejects bad
input, returns a full assessment, and that every hazard carries a valid confidence tier.
Run it before every deploy.

## Deploy

**Render (free):** push to GitHub → New → Blueprint → pick the repo. `render.yaml` does
the rest. Then set `NOMINATIM_USER_AGENT` under Environment.

**Docker:** `docker build -t climatemark . && docker run -p 5000:5000 climatemark`

**Any Node host:**
```
Build:   npm install --include=dev && npm run build
Start:   npm start
Health:  /healthz
```

`--include=dev` matters — with `NODE_ENV=production` set, npm skips devDependencies, and
vite/esbuild/typescript live there. Without it the build fails with `vite: not found`.

---

## What changed from ClimateIQ, and why

### 1. Confidence is a first-class type

The predecessor called FEMA's flood layer and a latitude heuristic the same thing: both
rendered as an identical gauge with an authoritative-looking source line. A user in Lyon
got the same visual confidence as a user in Miami behind wildly different epistemic
quality. That's not a polish problem — telling someone their home is high-risk on a
guess, when it might affect a purchase, is a liability problem.

Every hazard now resolves to one of three tiers:

| Tier | Meaning |
| --- | --- |
| **Measured** | Read from an official hazard dataset covering this exact point (FEMA NFHL polygon, USDA wildfire hazard raster). |
| **Modeled** | Computed from real observations here, through our model rather than an official designation (ERA5, CAMS). |
| **Estimated** | Regional or latitude-based approximation. A guess, and never displayed as anything else. |

`server/climate/confidence.ts` assigns these centrally from the reported data source, so
a new dataset can't accidentally inherit unearned confidence. Unrecognised sources fall
to `estimated` — the pessimistic default is the safe one. Authoritative layers that are
US-only are automatically downgraded outside US coverage.

### 2. The combined score can refuse to exist

`computeComposite` produces a weighted mean **only** when enough of that weight rests on
real data (`MIN_QUALITY_FOR_COMPOSITE = 0.45`). Below the threshold it returns `null` and
the UI shows the hazard breakdown plus an explicit withheld notice.

This is the most important guard in the app. It's what stops a latitude-based guess from
rendering identically to a measured flood zone.

### 3. The finding leads, not the composite

A house scoring 45 from moderate-everything and a house scoring 45 from catastrophic
flood risk need completely different responses. The report now opens with the dominant
hazard; the composite is demoted to second position.

Dominant hazard is deliberately **not** the highest raw score — severity is discounted by
confidence, so a measured 60 outranks an estimated 70.

### 4. Thirty-year windows, not ninety-day ones

The predecessor scored *climate* risk from a rolling 90-day weather window. That's a
category error: a wet spring made a house look flood-prone. ClimateMark adds a real
long-run view — 1991–2020 ERA5 normals against 2036–2065 CMIP6 downscaled projections,
both free and keyless. If either is unavailable the outlook is omitted rather than
guessed.

### 5. Recommendations respond to the property

Four optional fields (year built, roof, foundation, stories) reshape the advice:

- Wood shake roof + wildfire exposure → roof replacement jumps to the top, because it's
  the highest-leverage fix that exists and no location-only model can surface it
- Basement + flood exposure → elevate utilities. Slab foundation → that advice never appears
- Slab + drought → soil moisture management, because expansive clay cracks slabs
- Pre-1980 + heat → insulation audit, since that era was built to R-11 or less

Actions carry the score that triggered them, so ranking reflects exposure rather than
authoring order. Property-driven ones are labelled in the UI.

### 6. Real progress, not theater

The old UI cycled invented phrases like "Querying federal climate databases…" on a timer.
The report now ends with an actual source log: which datasets answered, which didn't, and
what tier each contributed.

### 7. Radically fewer dependencies

Dropped: the interactive globe (maplibre-gl), Tailwind, 3 Radix packages, framer-motion,
lucide-react, react-query, wouter, class-variance-authority, clsx, tailwind-merge, and 49
unused shadcn components.

**Runtime dependencies are now: react, react-dom, express, cross-env.** The globe was the
most impressive thing on the page and the least useful — it shipped a vector-tile engine
to every visitor so they could click imprecisely at a location they could type exactly.

Styling is hand-written CSS with a documented token system in `src/index.css`.

---

## Known gaps

Being explicit, because a risk product that hides its limits is the thing this rewrite
exists to argue against.

- **Weights are uncalibrated.** `HAZARD_WEIGHTS` are defensible estimates of relative
  insured loss, not coefficients fitted to data. Real calibration means regressing against
  FEMA OpenFEMA disaster declarations and NOAA Billion-Dollar Disasters.
- **No financial translation.** "Premiums in this ZIP rose 34% over three years" moves
  behavior; a risk score doesn't. That needs a licensed data source, so it's omitted
  rather than invented.
- **Coverage is US-centric.** Outside the US, flood/wildfire/drought fall back to
  modelling. The confidence system makes this visible, but the fix is ingesting Copernicus
  EMS and JRC's Global Flood Awareness System.
- **Live queries, not precomputed.** FEMA polygons change a few times a year yet we query
  them per request. Ingesting hazard layers into PostGIS and scoring over an H3 grid would
  take this from ~4s and six upstream dependencies to sub-50ms with zero external calls.
- **In-process cache.** Evaporates on deploy and doesn't shard. Redis or DynamoDB next.
- **No calibration study or error bars.** Required before any score is presented as
  decision-grade.

## Layout

```
shared/types.ts          contract — confidence tiers, hazards, outlook
server/
  index.ts               Express: API + static + dev Vite middleware
  routes.ts              /api/assess, /api/geocode, /healthz
  climate/
    confidence.ts        source string → confidence tier
    climatology.ts       ERA5 baseline vs CMIP6 projection
    scoring.ts           weights, quality gate, dominant hazard
    recommendations.ts   property-aware action engine
    providers.ts         geocoding chain: Nominatim → Photon → coordinates
    flood|wildfire|storms|heat|drought|airquality.ts
src/
  App.tsx                search, property details, report assembly
  components/Report.tsx  finding, composite, evidence ledger, outlook, actions
  index.css              design tokens and full stylesheet
```

## Configuration

All optional — see `.env.example`. `PORT`, `LOG_LEVEL`, and `NOMINATIM_USER_AGENT`.

Set `NOMINATIM_USER_AGENT` to a real contact address before real traffic. OpenStreetMap's
geocoder requires it and blocks by IP range.

## Naming

"ClimateMark" is a placeholder chosen for tone, not cleared for use. Run a trademark search
before putting it on anything public.

## Data sources

FEMA National Flood Hazard Layer · NOAA National Weather Service · USDA Forest Service
Wildfire Hazard Potential · US Drought Monitor (UNL) · Copernicus CAMS · Open-Meteo
(ERA5 archive, CMIP6 climate API, air quality, elevation) · Nominatim & Photon
(OpenStreetMap). All free, none requiring a key.

## Disclaimer

Not a professional risk assessment, insurance quote, or substitute for a survey or
inspection. Do not rely on it as the sole basis for a property transaction.
