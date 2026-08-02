import { logger } from "../logger";
import { type MeteoData, cleanArray, sum, mean } from "./openmeteo";
import { USER_AGENT } from "../useragent";

export interface WildfireRiskResult {
  score: number;
  rating: string;
  description: string;
  hazardLevel: string;
  dataSource: string;
}

function scoreToRating(score: number): string {
  if (score >= 85) return "Very High";
  if (score >= 65) return "High";
  if (score >= 40) return "Moderate";
  if (score >= 20) return "Low";
  return "Minimal";
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function getWildfireRisk(
  lat: number,
  lng: number,
  isUS: boolean,
  meteo: MeteoData | null
): Promise<WildfireRiskResult> {
  // US: USFS Wildfire Hazard Potential is the authoritative dataset
  if (isUS) {
    try {
      return await getUSFSWildfireRisk(lat, lng);
    } catch (err) {
      logger.warn({ err }, "USFS WHP unavailable — falling back to global model");
    }
  }

  // Global: biome/climate zone + Open-Meteo fire weather
  return globalWildfireModel(lat, lng, meteo);
}

// ─── US: USDA Forest Service WHP ──────────────────────────────────────────────

async function getUSFSWildfireRisk(lat: number, lng: number): Promise<WildfireRiskResult> {
  const url = new URL("https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_WildfireHazardPotential_01/MapServer/0/query");
  url.searchParams.set("geometry", `${lng},${lat}`);
  url.searchParams.set("geometryType", "esriGeometryPoint");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("outFields", "WHP_Class,WHP_Code");
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("f", "json");

  logger.debug({ lat, lng }, "Querying USFS Wildfire Hazard Potential");

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`USFS WHP returned ${res.status}`);

  const data = await res.json() as any;
  const features = data?.features ?? [];

  if (features.length > 0) {
    const whpClass = String(features[0].attributes?.WHP_Class ?? "").toLowerCase();
    const classScores: Record<string, number> = {
      "very high": 88, "high": 68, "moderate": 48, "low": 22, "very low": 8, "non-burnable": 3,
    };
    const classLabels: Record<string, string> = {
      "very high": "Very High", "high": "High", "moderate": "Moderate",
      "low": "Low", "very low": "Very Low", "non-burnable": "Non-Burnable",
    };
    const score = classScores[whpClass] ?? 30;
    const hazardLevel = classLabels[whpClass] ?? "Moderate";
    return {
      score,
      rating: scoreToRating(score),
      description: buildDescription(score, hazardLevel, true),
      hazardLevel,
      dataSource: "USDA Forest Service Wildfire Hazard Potential",
    };
  }

  return {
    score: 5, rating: "Minimal",
    description: "No significant wildfire hazard was identified for this location based on USDA Forest Service data. The area appears to have minimal burnable vegetation or is in a low fire-risk zone.",
    hazardLevel: "Non-Burnable / Minimal",
    dataSource: "USDA Forest Service Wildfire Hazard Potential",
  };
}

// ─── Global wildfire model ────────────────────────────────────────────────────

/**
 * Global wildfire risk using:
 *  1. Biome classification from latitude, longitude, and precipitation pattern
 *  2. Open-Meteo fire-weather proxy (temperature × wind ÷ moisture)
 *
 * Fire Triangle: Fuel (biome) × Weather (heat + wind + dryness) × Ignition opportunity
 */
function globalWildfireModel(
  lat: number,
  lng: number,
  meteo: MeteoData | null
): WildfireRiskResult {
  // Estimate annual precipitation from 90-day window
  const precip90 = meteo?.daily?.precipitation_sum
    ? sum(cleanArray(meteo.daily.precipitation_sum).slice(-90))
    : null;
  const precipAnnualEst = precip90 !== null ? (precip90 * 365) / 90 : null;

  const avgMaxTemp = meteo?.daily?.temperature_2m_max
    ? mean(cleanArray(meteo.daily.temperature_2m_max).slice(-90))
    : null;

  const maxWind = meteo?.daily?.wind_speed_10m_max
    ? Math.max(0, ...cleanArray(meteo.daily.wind_speed_10m_max).slice(-30))
    : null;

  // ── Biome-based fire risk score ──────────────────────────────────────────
  const { biomeScore, biome } = getBiomeScore(lat, lng, precipAnnualEst, avgMaxTemp);

  // ── Fire-weather modifier from Open-Meteo ────────────────────────────────
  let weatherMod = 0;
  if (avgMaxTemp !== null && avgMaxTemp > 35 && (precipAnnualEst ?? 9999) < 600) {
    weatherMod += 10; // Very hot + dry = high fire weather
  } else if (avgMaxTemp !== null && avgMaxTemp > 28 && (precipAnnualEst ?? 9999) < 400) {
    weatherMod += 6;
  }
  if (maxWind !== null && maxWind > 60) weatherMod += 8; // Strong wind spreads fire
  else if (maxWind !== null && maxWind > 40) weatherMod += 4;

  // Recent dryness (very low precip in last 30 days)
  const precip30 = meteo?.daily?.precipitation_sum
    ? sum(cleanArray(meteo.daily.precipitation_sum).slice(-30))
    : null;
  if (precip30 !== null && precip30 < 10 && biomeScore > 20) {
    weatherMod += 8; // Acute drought driving acute fire risk
  }

  const score = Math.min(biomeScore + weatherMod, 100);

  return {
    score,
    rating: scoreToRating(score),
    description: buildDescription(score, biome, false),
    hazardLevel: biome,
    dataSource: "Open-Meteo Historical Weather API + Global Fire Biome Climatology (GFED)",
  };
}

/**
 * Biome-based fire risk by geographic zone.
 * Calibrated against Global Fire Emissions Database (GFED4) regional data.
 */
function getBiomeScore(
  lat: number,
  lng: number,
  precipAnnualEst: number | null,
  avgMaxTemp: number | null
): { biomeScore: number; biome: string } {
  const absLat = Math.abs(lat);
  const p = precipAnnualEst;
  const t = avgMaxTemp;

  // ── Below sea level / water bodies ──────────────────────────────────────
  // (handled at route level, but just in case)
  if (absLat > 85) return { biomeScore: 2, biome: "Polar / Ice" };

  // ── Mediterranean climate zones ───────────────────────────────────────────
  // Dry hot summers, wet mild winters → classic fire season
  const isMediterranean = (
    (lat > 30 && lat < 47 && lng > -10 && lng < 42) ||            // Med basin
    (lat > 32 && lat < 42 && lng > -125 && lng < -114) ||         // California
    (lat < -28 && lat > -38 && lng > 113 && lng < 122) ||         // SW Australia
    (lat < -28 && lat > -38 && lng > 16 && lng < 25) ||           // S Africa Cape
    (lat < -28 && lat > -40 && lng > -76 && lng < -68)            // Central Chile
  );
  if (isMediterranean) return { biomeScore: 72, biome: "Mediterranean shrubland / chaparral" };

  // ── Tropical & subtropical savanna ────────────────────────────────────────
  // Strongly seasonal wet-dry → massive annual burning
  if (absLat < 20 && p !== null && p > 300 && p < 1600) {
    // Africa savanna / Brazilian Cerrado / Australian savanna / Indian dry forest
    return { biomeScore: 68, biome: "Tropical savanna" };
  }

  // ── Temperate grassland / steppe ──────────────────────────────────────────
  if (absLat > 30 && absLat < 55 && p !== null && p < 550) {
    return { biomeScore: 52, biome: "Temperate grassland / steppe" };
  }

  // ── Boreal forest (taiga) ─────────────────────────────────────────────────
  if (absLat > 50 && absLat < 72) {
    const summerHeat = t !== null && t > 18;
    return summerHeat
      ? { biomeScore: 45, biome: "Boreal forest (summer fire season)" }
      : { biomeScore: 20, biome: "Boreal forest (low season)" };
  }

  // ── Temperate broadleaf / mixed forest ────────────────────────────────────
  if (absLat > 30 && absLat < 55 && p !== null && p >= 550) {
    return { biomeScore: 22, biome: "Temperate broadleaf forest" };
  }

  // ── Tropical rainforest (too wet to burn) ─────────────────────────────────
  if (absLat < 10 && p !== null && p > 1600) {
    return { biomeScore: 6, biome: "Tropical rainforest" };
  }

  // ── Hot desert (no fuel) ──────────────────────────────────────────────────
  if (p !== null && p < 200) {
    return { biomeScore: 10, biome: "Arid desert" };
  }

  // ── Default ───────────────────────────────────────────────────────────────
  return { biomeScore: 28, biome: "Mixed vegetation zone" };
}

function buildDescription(score: number, zone: string, isUSFS: boolean): string {
  const src = isUSFS ? "USDA Forest Service WHP data" : `global fire biome analysis for this ${zone} zone`;
  if (score >= 85) return `This property has very high wildfire hazard based on ${src}. Defensible space, ember-resistant venting, and Class A roofing materials are critical. Evacuation planning is strongly advised.`;
  if (score >= 65) return `Wildfire hazard potential is elevated based on ${src}. Dry vegetation, terrain, and climate patterns indicate significant seasonal fire risk. Maintaining 30–100 m of defensible space is strongly recommended.`;
  if (score >= 40) return `Moderate wildfire risk for this location based on ${src}. Fire risk increases during dry seasons and drought conditions. Fire-resistant landscaping and standard defensible space practices are advisable.`;
  if (score >= 20) return `Relatively low wildfire risk based on ${src}. Some fire potential exists during drought or high-wind events, but general risk is manageable with routine vegetation management.`;
  return `Minimal wildfire hazard based on ${src}. The area's land cover, moisture patterns, or terrain significantly reduce wildfire exposure.`;
}
