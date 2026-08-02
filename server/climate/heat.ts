import { logger } from "../logger";
import { type MeteoData, cleanArray } from "./openmeteo";
import { USER_AGENT } from "../useragent";

export interface HeatRiskResult {
  score: number;
  rating: string;
  description: string;
  annualExtremeHeatDays: number;
  dataSource: string;
}

function scoreToRating(score: number): string {
  if (score >= 85) return "Very High";
  if (score >= 65) return "High";
  if (score >= 40) return "Moderate";
  if (score >= 20) return "Low";
  return "Minimal";
}

function buildDescription(score: number, extremeDays: number, peakTempC: number | null): string {
  const peakF = peakTempC !== null ? Math.round(peakTempC * 9 / 5 + 32) : null;
  const peakStr = peakF !== null ? ` (peak ${peakF}°F / ${Math.round(peakTempC!)}°C observed recently)` : "";

  if (score >= 85) {
    return `This location experiences extreme heat conditions${peakStr}, with an estimated ${extremeDays}+ days per year above 95°F/35°C. Heat-related health risks are severe, cooling costs are very high, and outdoor activity is dangerous during summer months. Quality insulation and efficient HVAC are critical investments.`;
  }
  if (score >= 65) {
    return `Significant heat affects this property${peakStr}, with approximately ${extremeDays} extreme heat days annually. Energy costs for cooling are substantially elevated and heat-related illness risk is meaningful in summer. Insulation and HVAC efficiency are important property considerations.`;
  }
  if (score >= 40) {
    return `This area experiences moderate heat exposure${peakStr}. Periodic extreme heat events occur and are expected to increase in frequency over coming decades. Adequate insulation and efficient cooling systems are advisable.`;
  }
  if (score >= 20) {
    return `Heat risk is relatively low for this location${peakStr}. Summers are warm but rarely reach dangerous extremes. Standard cooling systems should be sufficient.`;
  }
  return `This location has minimal extreme heat exposure${peakStr}. The climate is typically mild, with few if any days reaching dangerous heat thresholds.`;
}

/**
 * Estimate heat risk using Open-Meteo 90-day historical temperature data.
 * Falls back to NOAA NWS for US locations if Open-Meteo is unavailable.
 */
export async function getHeatRisk(
  lat: number,
  lng: number,
  isUS: boolean,
  meteo: MeteoData | null
): Promise<HeatRiskResult> {
  // ── Try Open-Meteo data (primary for all regions) ─────────────────────────
  if (meteo?.daily?.temperature_2m_max) {
    const temps = cleanArray(meteo.daily.temperature_2m_max);
    if (temps.length >= 14) {
      const recent = temps.slice(-90);
      const avgMax = recent.reduce((a, b) => a + b, 0) / recent.length;
      const peakTemp = Math.max(...recent);
      const daysAbove35 = recent.filter(t => t >= 35).length;
      const daysAbove40 = recent.filter(t => t >= 40).length;

      // Scale 90-day counts to annual estimates
      const extremeDaysAnnual = Math.round(daysAbove35 * (365 / recent.length));

      // Score based on 90-day average daily max temperature
      let score: number;
      if (avgMax >= 42)      score = 96;
      else if (avgMax >= 38) score = 88;
      else if (avgMax >= 34) score = 72;
      else if (avgMax >= 30) score = 55;
      else if (avgMax >= 26) score = 38;
      else if (avgMax >= 22) score = 22;
      else if (avgMax >= 16) score = 12;
      else                   score = 5;

      // Boost for sustained extreme events in observed window
      if (daysAbove40 >= 10) score = Math.min(score + 10, 100);
      else if (daysAbove40 >= 3) score = Math.min(score + 5, 100);
      if (daysAbove35 >= 30)  score = Math.min(score + 5, 100);

      return {
        score,
        rating: scoreToRating(score),
        description: buildDescription(score, extremeDaysAnnual, peakTemp),
        annualExtremeHeatDays: extremeDaysAnnual,
        dataSource: "Open-Meteo Historical Weather API (ERA5 reanalysis)",
      };
    }
  }

  // ── US fallback: NOAA NWS forecast + regional baseline ───────────────────
  if (isUS) {
    logger.debug({ lat, lng }, "Open-Meteo unavailable — trying NOAA NWS for heat");
    return getUSHeatRisk(lat, lng);
  }

  // ── Ultimate fallback: latitude-based climate zone estimate ───────────────
  return latitudeHeatFallback(lat);
}

// ─── US NOAA NWS fallback ─────────────────────────────────────────────────────

async function getUSHeatRisk(lat: number, lng: number): Promise<HeatRiskResult> {
  let forecastHighTemp: number | null = null;
  try {
    const pointRes = await fetch(
      `https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`,
      { headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" }, signal: AbortSignal.timeout(8000) }
    );
    if (pointRes.ok) {
      const pointData = await pointRes.json() as any;
      const hourlyUrl = pointData?.properties?.forecastHourly;
      if (hourlyUrl) {
        const fRes = await fetch(hourlyUrl, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" },
          signal: AbortSignal.timeout(8000),
        });
        if (fRes.ok) {
          const fd = await fRes.json() as any;
          const periods = fd?.properties?.periods ?? [];
          const temps = periods.slice(0, 168).map((p: any) => {
            const t = p?.temperature;
            const u = p?.temperatureUnit;
            if (typeof t !== "number") return null;
            return u === "C" ? (t * 9) / 5 + 32 : t;
          }).filter((t: any): t is number => t !== null);
          if (temps.length > 0) forecastHighTemp = Math.max(...temps);
        }
      }
    }
  } catch {
    // ignore
  }

  const { score: base, extremeDays } = usRegionalHeatBaseline(lat, lng);
  let score = base;
  if (forecastHighTemp !== null) {
    if (forecastHighTemp >= 110)      score = Math.min(score + 10, 100);
    else if (forecastHighTemp >= 100) score = Math.min(score + 5, 100);
    else if (forecastHighTemp >= 95)  score = Math.min(score + 2, 100);
    else if (forecastHighTemp < 70)   score = Math.max(score - 3, 0);
  }
  return {
    score,
    rating: scoreToRating(score),
    description: buildDescription(score, extremeDays, forecastHighTemp !== null ? (forecastHighTemp - 32) * 5 / 9 : null),
    annualExtremeHeatDays: extremeDays,
    dataSource: "NOAA National Weather Service / NOAA Climate Divisional Data",
  };
}

function usRegionalHeatBaseline(lat: number, lng: number): { score: number; extremeDays: number } {
  if (lat < 37 && lng < -108 && lng > -118) return { score: 95, extremeDays: 110 };
  if (lat > 35 && lat < 41 && lng > -122 && lng < -118) return { score: 70, extremeDays: 40 };
  if (lat < 34 && lng > -100 && lng < -93) return { score: 80, extremeDays: 60 };
  if (lat < 35 && lng > -93 && lng < -79) return { score: 68, extremeDays: 30 };
  if (lat > 33 && lat < 38 && lng > -103 && lng < -93) return { score: 65, extremeDays: 25 };
  if (lat > 30 && lat < 40 && lng > -82 && lng < -74) return { score: 52, extremeDays: 12 };
  if (lat > 36 && lat < 44 && lng > -93 && lng < -80) return { score: 45, extremeDays: 8 };
  if (lat > 38 && lat < 47 && lng > -80 && lng < -66) return { score: 32, extremeDays: 4 };
  if (lat > 44 && lng < -120) return { score: 22, extremeDays: 2 };
  if (lat > 40 && lng < -104) return { score: 30, extremeDays: 5 };
  if (lat > 43 && lng > -93 && lng < -76) return { score: 28, extremeDays: 3 };
  return { score: 40, extremeDays: 8 };
}

// ─── Global latitude fallback ─────────────────────────────────────────────────

function latitudeHeatFallback(lat: number): HeatRiskResult {
  const absLat = Math.abs(lat);
  let score: number;
  let extremeDays: number;

  if (absLat < 10)       { score = 75; extremeDays = 180; } // Equatorial — perma-hot
  else if (absLat < 20)  { score = 68; extremeDays = 90; }  // Tropical
  else if (absLat < 30)  { score = 60; extremeDays = 45; }
  else if (absLat < 40)  { score = 45; extremeDays = 20; }  // Subtropical/temperate
  else if (absLat < 50)  { score = 28; extremeDays = 8; }   // Temperate
  else if (absLat < 60)  { score = 15; extremeDays = 2; }   // Cool temperate
  else                   { score = 5;  extremeDays = 0; }   // Subarctic/polar

  return {
    score,
    rating: scoreToRating(score),
    description: buildDescription(score, extremeDays, null),
    annualExtremeHeatDays: extremeDays,
    dataSource: "Climatological estimate (latitude-based)",
  };
}
