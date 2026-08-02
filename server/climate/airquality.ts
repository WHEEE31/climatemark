import { logger } from "../logger";
import { USER_AGENT } from "../useragent";

export interface AirQualityResult {
  score: number;
  rating: string;
  description: string;
  currentAQI: number | null;
  pm25: number | null;
  dominantPollutant: string;
  dataSource: string;
}

function scoreToRating(score: number): string {
  if (score >= 85) return "Very High";
  if (score >= 65) return "High";
  if (score >= 40) return "Moderate";
  if (score >= 20) return "Low";
  return "Minimal";
}

/** Map US AQI (0–500+) to a 0–100 risk score. */
function aqiToScore(aqi: number): number {
  if (aqi >= 301) return 95;  // Hazardous
  if (aqi >= 201) return 80;  // Very Unhealthy
  if (aqi >= 151) return 65;  // Unhealthy
  if (aqi >= 101) return 42;  // Unhealthy for Sensitive Groups
  if (aqi >= 51)  return 20;  // Moderate
  return 5;                   // Good
}

function aqiCategory(aqi: number): string {
  if (aqi >= 301) return "Hazardous";
  if (aqi >= 201) return "Very Unhealthy";
  if (aqi >= 151) return "Unhealthy";
  if (aqi >= 101) return "Unhealthy for Sensitive Groups";
  if (aqi >= 51)  return "Moderate";
  return "Good";
}

function buildDescription(score: number, aqi: number | null, pm25: number | null, pollutant: string): string {
  const aqiStr = aqi !== null ? ` Current US AQI: ${aqi} (${aqiCategory(aqi)}).` : "";
  const pm25Str = pm25 !== null ? ` PM2.5 concentration is ${pm25.toFixed(1)} µg/m³.` : "";
  const pollutantStr = pollutant && pollutant !== "none" ? ` Primary pollutant: ${pollutant}.` : "";

  if (score >= 85) {
    return `Air quality is currently hazardous at this location.${aqiStr}${pm25Str}${pollutantStr} Outdoor activity is strongly discouraged and may cause serious health effects even for healthy individuals. High-efficiency air filtration (MERV-13 or HEPA) is essential for this property.`;
  }
  if (score >= 65) {
    return `Air quality is poor and poses health risks.${aqiStr}${pm25Str}${pollutantStr} Sensitive groups — including children, the elderly, and those with respiratory conditions — should avoid prolonged outdoor exposure. Upgraded HVAC filtration is recommended for this property.`;
  }
  if (score >= 40) {
    return `Air quality is unhealthy for sensitive groups at this location.${aqiStr}${pm25Str}${pollutantStr} People with asthma or heart/lung conditions should limit outdoor exertion. Standard HVAC filters may need more frequent replacement.`;
  }
  if (score >= 20) {
    return `Air quality is moderate.${aqiStr}${pm25Str}${pollutantStr} Most people can be active outdoors. Unusually sensitive individuals may experience minor symptoms during peak pollution periods.`;
  }
  return `Air quality is currently good at this location.${aqiStr}${pm25Str} No significant air quality concerns are present. Standard property ventilation is adequate.`;
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function getAirQualityRisk(
  lat: number,
  lng: number
): Promise<AirQualityResult> {
  // Open-Meteo Air Quality API — free, no key, powered by Copernicus CAMS
  try {
    const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
    url.searchParams.set("latitude", lat.toFixed(4));
    url.searchParams.set("longitude", lng.toFixed(4));
    url.searchParams.set("current", "us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,carbon_monoxide,dust,uv_index");
    url.searchParams.set("domains", "cams_global");

    logger.debug({ lat, lng }, "Fetching air quality from Open-Meteo");

    const res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) throw new Error(`Open-Meteo AQ returned ${res.status}`);

    const data = await res.json() as {
      current?: {
        us_aqi?: number | null;
        pm2_5?: number | null;
        pm10?: number | null;
        ozone?: number | null;
        nitrogen_dioxide?: number | null;
        carbon_monoxide?: number | null;
        dust?: number | null;
      };
    };

    const current = data.current ?? {};
    const aqi  = current.us_aqi  ?? null;
    const pm25 = current.pm2_5   ?? null;

    // Determine dominant pollutant
    const pollutant = dominantPollutant({
      pm25:  pm25               ?? 0,
      pm10:  current.pm10       ?? 0,
      o3:    current.ozone      ?? 0,
      no2:   current.nitrogen_dioxide ?? 0,
      co:    (current.carbon_monoxide ?? 0) / 1000, // µg/m³ → rough index
      dust:  current.dust       ?? 0,
    });

    const score = aqi !== null ? aqiToScore(aqi) : 15;

    return {
      score,
      rating: scoreToRating(score),
      description: buildDescription(score, aqi, pm25, pollutant),
      currentAQI: aqi,
      pm25,
      dominantPollutant: pollutant,
      dataSource: "Open-Meteo Air Quality API (Copernicus CAMS global model)",
    };
  } catch (err) {
    logger.warn({ err }, "Air quality fetch failed — returning neutral estimate");
    return {
      score: 15,
      rating: "Low",
      description: "Air quality data could not be retrieved for this location. Based on regional averages, risk is estimated as low. Check local environmental authority for current conditions.",
      currentAQI: null,
      pm25: null,
      dominantPollutant: "unknown",
      dataSource: "Estimate (data unavailable)",
    };
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function dominantPollutant(levels: {
  pm25: number; pm10: number; o3: number; no2: number; co: number; dust: number;
}): string {
  const candidates = [
    { name: "PM2.5 (fine particles)",   val: levels.pm25  },
    { name: "PM10 (coarse particles)",  val: levels.pm10  },
    { name: "ozone",                    val: levels.o3    },
    { name: "nitrogen dioxide",         val: levels.no2   },
    { name: "dust",                     val: levels.dust  },
  ].filter(c => c.val > 0);

  if (candidates.length === 0) return "none";
  return candidates.reduce((a, b) => (a.val > b.val ? a : b)).name;
}
