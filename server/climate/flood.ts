import { logger } from "../logger";
import { type MeteoData, cleanArray, sum } from "./openmeteo";
import { USER_AGENT } from "../useragent";

export interface FloodRiskResult {
  score: number;
  rating: string;
  description: string;
  floodZone: string;
  dataSource: string;
}

function scoreToRating(score: number): string {
  if (score >= 85) return "Very High";
  if (score >= 70) return "High";
  if (score >= 45) return "Moderate";
  if (score >= 25) return "Low";
  return "Minimal";
}

// ─── FEMA flood zone mapping (US) ─────────────────────────────────────────────

const FLOOD_ZONE_SCORES: Record<string, number> = {
  A: 85, AE: 85, AH: 80, AO: 80, AR: 75, "A99": 70,
  VE: 95, V: 95,
  X: 20, "X500": 40, B: 40, C: 15, D: 50,
};
const FLOOD_ZONE_LABELS: Record<string, string> = {
  A: "Special Flood Hazard Area (Zone A)", AE: "Special Flood Hazard Area (Zone AE)",
  AH: "Special Flood Hazard Area — shallow flooding (Zone AH)",
  AO: "Special Flood Hazard Area — sheet flow (Zone AO)",
  AR: "Special Flood Hazard Area — levee (Zone AR)",
  "A99": "Special Flood Hazard Area — levee under construction",
  VE: "Coastal High Hazard Area (Zone VE)", V: "Coastal High Hazard Area (Zone V)",
  X: "Minimal flood hazard (Zone X)", "X500": "Moderate flood hazard — 500-year floodplain",
  B: "Moderate flood hazard (Zone B)", C: "Minimal flood hazard (Zone C)",
  D: "Undetermined flood hazard (Zone D)",
};

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function getFloodRisk(
  lat: number,
  lng: number,
  isUS: boolean,
  meteo: MeteoData | null
): Promise<FloodRiskResult> {
  // US: FEMA NFHL is the most accurate source
  if (isUS) {
    try {
      return await getFEMAFloodRisk(lat, lng);
    } catch (err) {
      logger.warn({ err }, "FEMA NFHL unavailable — falling back to elevation model");
    }
  }

  // Global: elevation + precipitation model
  return elevationFloodModel(lat, lng, meteo);
}

// ─── FEMA NFHL (US) ───────────────────────────────────────────────────────────

async function getFEMAFloodRisk(lat: number, lng: number): Promise<FloodRiskResult> {
  const url = new URL("https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query");
  url.searchParams.set("geometry", `${lng},${lat}`);
  url.searchParams.set("geometryType", "esriGeometryPoint");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("outFields", "FLD_ZONE,ZONE_SUBTY,SFHA_TF");
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("f", "json");

  logger.debug({ lat, lng }, "Querying FEMA NFHL flood zones");

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) throw new Error(`FEMA NFHL returned ${res.status}`);

  const data = await res.json() as any;
  const features = data?.features ?? [];

  let floodZone = "X";
  if (features.length > 0) {
    const attrs = features[0].attributes;
    floodZone = (attrs?.FLD_ZONE ?? "X").trim().toUpperCase();
    if (floodZone === "X" && attrs?.ZONE_SUBTY === "0.2 PCT ANNUAL CHANCE FLOOD HAZARD") {
      floodZone = "X500";
    }
  }

  const score = FLOOD_ZONE_SCORES[floodZone] ?? 20;
  return {
    score,
    rating: scoreToRating(score),
    description: buildFEMADescription(floodZone, score),
    floodZone,
    dataSource: "FEMA National Flood Hazard Layer (NFHL)",
  };
}

function buildFEMADescription(floodZone: string, score: number): string {
  const zoneLabel = FLOOD_ZONE_LABELS[floodZone] ?? floodZone;
  if (score >= 85) return `This property falls within a FEMA Special Flood Hazard Area (${zoneLabel}). Federal flood insurance is typically required for federally-backed mortgages, and annual flooding is statistically significant.`;
  if (score >= 70) return `This property is in a high-risk flood zone (${zoneLabel}). There is a meaningful chance of flooding over a 30-year mortgage period, and insurance costs may be substantial.`;
  if (score >= 45) return `This property lies in a moderate flood risk area (${zoneLabel}). While outside the 100-year floodplain, flooding from major storms remains possible.`;
  if (score >= 25) return `This property has low flood risk based on FEMA flood zone mapping (${zoneLabel}). Flooding is uncommon but not impossible during extreme weather events.`;
  return `This property is in a minimal flood risk zone (${zoneLabel}). FEMA data indicates a very low probability of flooding under most weather scenarios.`;
}

// ─── Global: elevation + precipitation model ──────────────────────────────────

/**
 * Flood model for non-US locations (or US FEMA fallback).
 *
 * Drivers:
 *  1. Elevation (metres) — low-lying areas flood first
 *  2. 90-day precipitation intensity — high rainfall drives pluvial/river flooding
 *  3. Coastal proximity heuristic — very low elevation near coast ≈ storm-surge risk
 */
function elevationFloodModel(
  lat: number,
  lng: number,
  meteo: MeteoData | null
): FloodRiskResult {
  const elevation = meteo?.elevation ?? null;

  // Base score from elevation
  let score: number;
  let zoneLabel: string;

  if (elevation === null) {
    // No elevation data — use regional heuristic
    score = 30;
    zoneLabel = "Elevation data unavailable";
  } else if (elevation <= 0) {
    score = 92; zoneLabel = "Below sea level";
  } else if (elevation < 5) {
    score = 78; zoneLabel = "Very low-lying (<5 m)";
  } else if (elevation < 15) {
    score = 60; zoneLabel = "Low-lying (5–15 m)";
  } else if (elevation < 50) {
    score = 38; zoneLabel = "Moderate elevation (15–50 m)";
  } else if (elevation < 200) {
    score = 20; zoneLabel = "Elevated terrain (50–200 m)";
  } else if (elevation < 500) {
    score = 12; zoneLabel = "High terrain (200–500 m)";
  } else {
    score = 6; zoneLabel = "Mountain terrain (>500 m)";
  }

  // Precipitation boost: monsoon / very wet climates add pluvial flood risk
  if (meteo?.daily?.precipitation_sum) {
    const precip90 = sum(cleanArray(meteo.daily.precipitation_sum).slice(-90));
    const maxDayPrecip = Math.max(0, ...cleanArray(meteo.daily.precipitation_sum).slice(-30));

    if (precip90 > 1500)    score = Math.min(score + 18, 100); // Intense monsoon
    else if (precip90 > 900) score = Math.min(score + 10, 100);
    else if (precip90 > 500) score = Math.min(score + 5, 100);

    // Single extreme rainfall day indicates flash-flood potential
    if (maxDayPrecip > 150)  score = Math.min(score + 12, 100);
    else if (maxDayPrecip > 80) score = Math.min(score + 6, 100);
  }

  const elevStr = elevation !== null ? `${Math.round(elevation)} m elevation` : "unknown elevation";
  return {
    score,
    rating: scoreToRating(score),
    description: buildElevationDescription(score, zoneLabel, elevStr, elevation),
    floodZone: zoneLabel,
    dataSource: "Open-Meteo Elevation (SRTM 90m) + Precipitation Analysis",
  };
}

function buildElevationDescription(score: number, zone: string, elevStr: string, elev: number | null): string {
  if (score >= 85) return `This location (${elevStr}) is at very high flood risk. Extremely low-lying or below-sea-level terrain makes this area highly susceptible to riverine flooding, storm surge, and extreme precipitation events. Flood insurance is strongly recommended.`;
  if (score >= 70) return `High flood risk is indicated for this location (${elevStr}, ${zone}). The low elevation creates significant exposure to coastal storm surge and river flooding. Flood mitigation and insurance are important considerations.`;
  if (score >= 45) return `Moderate flood risk based on terrain analysis (${elevStr}). While not in an extreme flood-prone area, the elevation and local precipitation patterns create meaningful flood exposure during major rain events.`;
  if (score >= 25) return `Relatively low flood risk for this location (${elevStr}). Terrain analysis indicates limited exposure to riverine or coastal flooding, though localised flash flooding from extreme rainfall remains possible.`;
  return `Minimal flood risk based on terrain analysis. The elevated terrain (${elevStr}) significantly reduces exposure to riverine and coastal flooding. Flash flooding from extreme precipitation remains a theoretical possibility in steep terrain.`;
}
