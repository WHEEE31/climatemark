import { logger } from "../logger";
import { type MeteoData, cleanArray, sum } from "./openmeteo";
import { USER_AGENT } from "../useragent";

export interface DroughtRiskResult {
  score: number;
  rating: string;
  description: string;
  currentLevel: string;
  dataSource: string;
}

function scoreToRating(score: number): string {
  if (score >= 85) return "Very High";
  if (score >= 65) return "High";
  if (score >= 40) return "Moderate";
  if (score >= 20) return "Low";
  return "Minimal";
}

// ─── US Drought Monitor constants ─────────────────────────────────────────────

const DROUGHT_CATEGORY_SCORES: Record<string, number> = {
  None: 5, D0: 25, D1: 45, D2: 62, D3: 78, D4: 92,
};
const DROUGHT_CATEGORY_LABELS: Record<string, string> = {
  None: "No drought conditions",
  D0: "Abnormally dry",
  D1: "Moderate drought",
  D2: "Severe drought",
  D3: "Extreme drought",
  D4: "Exceptional drought",
};

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function getDroughtRisk(
  lat: number,
  lng: number,
  isUS: boolean,
  meteo: MeteoData | null
): Promise<DroughtRiskResult> {
  // US: try the authoritative Drought Monitor first
  if (isUS) {
    try {
      return await getUSDMRisk(lat, lng);
    } catch (err) {
      logger.warn({ err }, "USDM unavailable — falling back to Open-Meteo for drought");
    }
  }

  // Global (or US fallback): Open-Meteo water-balance method
  if (meteo?.daily?.precipitation_sum && meteo?.daily?.et0_fao_evapotranspiration) {
    return openMeteoWaterBalance(meteo);
  }

  // Last-resort: climate-zone estimate
  return climateFallback(lat);
}

// ─── US Drought Monitor ───────────────────────────────────────────────────────

async function getUSDMRisk(lat: number, lng: number): Promise<DroughtRiskResult> {
  const lastTue = getLastTuesday();
  const dateStr = formatDate(lastTue);
  const wkt = `POINT(${lng} ${lat})`;

  const endpoints = [
    `https://usdm.climate.unl.edu/api/usdmstatistics/getdrynessstats?aoi=${encodeURIComponent(wkt)}&aoitype=wkt&statisticstype=2&startdate=${dateStr}&enddate=${dateStr}`,
    `https://usdm.climate.unl.edu/api/usdmstatistics/getuserstats?aoi=${encodeURIComponent(wkt)}&aoitype=wkt&statisticstype=2&startdate=${dateStr}&enddate=${dateStr}`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;

      const data = await res.json() as any;
      if (!Array.isArray(data) || data.length === 0) continue;

      let worstCategory = "None";
      const row = data[0];
      for (const cat of ["D4", "D3", "D2", "D1", "D0"]) {
        if (parseFloat(row?.[cat] ?? "0") > 0) { worstCategory = cat; break; }
      }

      const score = DROUGHT_CATEGORY_SCORES[worstCategory] ?? 5;
      return {
        score,
        rating: scoreToRating(score),
        description: buildUSDMDescription(worstCategory, score),
        currentLevel: DROUGHT_CATEGORY_LABELS[worstCategory] ?? worstCategory,
        dataSource: "US Drought Monitor (University of Nebraska–Lincoln)",
      };
    } catch {
      continue;
    }
  }
  throw new Error("All USDM endpoints failed");
}

function buildUSDMDescription(category: string, score: number): string {
  if (score >= 85) return `Exceptional drought (D4) is currently affecting this area — the highest level tracked by the US Drought Monitor. Water shortages, wildfire risk, and agricultural stress are severely elevated. Long-term water availability for this property may be at risk.`;
  if (score >= 65) return `This location is experiencing ${DROUGHT_CATEGORY_LABELS[category] ?? category} conditions. Water restrictions, elevated wildfire danger, and reduced groundwater are likely. Landscape irrigation and outdoor water use will be significantly constrained.`;
  if (score >= 40) return `Moderate drought conditions exist in this area. Water usage restrictions may be in effect seasonally. Soil moisture deficits may affect property maintenance and landscaping costs.`;
  if (score >= 20) return `Some dryness above normal is present, but conditions remain manageable. Monitor local water authority advisories during summer months.`;
  return `No significant drought stress is currently recorded for this location. Water availability appears normal based on US Drought Monitor data.`;
}

// ─── Open-Meteo water-balance method (global) ─────────────────────────────────

/**
 * Climatic Water Balance = Precipitation − Reference Evapotranspiration (ET₀)
 *
 * A large negative balance over 90 days indicates drought stress; a positive
 * balance indicates adequate moisture.  Thresholds are calibrated against USDM
 * categories for US validation data.
 */
function openMeteoWaterBalance(meteo: MeteoData): DroughtRiskResult {
  const precip = cleanArray(meteo.daily.precipitation_sum);
  const et0    = cleanArray(meteo.daily.et0_fao_evapotranspiration);
  const n      = Math.min(precip.length, et0.length, 90);

  const totalP   = sum(precip.slice(-n));   // mm of rain over period
  const totalET0 = sum(et0.slice(-n));      // mm of potential evaporation

  // Climatic Water Balance (positive = surplus, negative = deficit)
  const cwb = totalP - totalET0;

  let score: number;
  let level: string;
  let description: string;

  if (cwb < -400) {
    score = 85; level = "Severe water deficit";
    description = `This location is experiencing a severe moisture deficit of ${Math.round(Math.abs(cwb))} mm over the past 90 days (precipitation ${Math.round(totalP)} mm vs. evapotranspiration demand ${Math.round(totalET0)} mm). Drought stress is significant, with elevated wildfire risk and water scarcity likely. Long-term water supply and property maintenance costs are meaningfully elevated.`;
  } else if (cwb < -200) {
    score = 65; level = "Significant water deficit";
    description = `A notable moisture deficit of ${Math.round(Math.abs(cwb))} mm has developed over the past 90 days. Vegetation stress, water restrictions, and elevated fire danger are possible. Property landscape irrigation requirements are substantially above average.`;
  } else if (cwb < -80) {
    score = 42; level = "Moderate water deficit";
    description = `This area shows a moderate moisture shortfall (${Math.round(Math.abs(cwb))} mm deficit over 90 days). Seasonal dryness is influencing soil moisture and vegetation. Irrigation and water conservation practices are advisable.`;
  } else if (cwb < 50) {
    score = 18; level = "Near-normal moisture balance";
    description = `Moisture conditions are broadly near normal for this location. Precipitation and evapotranspiration are roughly balanced over the past 90 days, with no significant drought stress identified.`;
  } else {
    score = 5; level = "Water surplus";
    description = `This location is receiving substantially more precipitation than evapotranspiration demand (surplus of ${Math.round(cwb)} mm over 90 days), indicating no drought risk. Excess moisture may instead elevate flood risk.`;
  }

  return {
    score,
    rating: scoreToRating(score),
    description,
    currentLevel: level,
    dataSource: "Open-Meteo Historical Weather API (ERA5 — precipitation & ET₀)",
  };
}

// ─── Climate-zone fallback ────────────────────────────────────────────────────

function climateFallback(lat: number): DroughtRiskResult {
  const absLat = Math.abs(lat);
  let score: number;
  let level: string;

  // Very rough aridity by latitude band
  if (absLat < 10)       { score = 10; level = "Tropical — generally humid"; }
  else if (absLat < 25)  { score = 55; level = "Subtropical — seasonally dry"; }
  else if (absLat < 35)  { score = 45; level = "Semi-arid subtropical"; }
  else if (absLat < 50)  { score = 22; level = "Temperate — variable"; }
  else                   { score = 12; level = "Cool/cold — low evaporation"; }

  return {
    score,
    rating: scoreToRating(score),
    description: `Drought data could not be retrieved. Based on the regional climate zone the estimated risk is ${scoreToRating(score).toLowerCase()}. We recommend checking local meteorological services for current conditions.`,
    currentLevel: level,
    dataSource: "Climatological estimate (latitude-based)",
  };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function getLastTuesday(): Date {
  const today = new Date();
  const day = today.getDay();
  const daysBack = ((day + 5) % 7) + 1;
  const d = new Date(today);
  d.setDate(today.getDate() - daysBack);
  return d;
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
