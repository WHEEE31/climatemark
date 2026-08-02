import { logger } from "../logger";
import { USER_AGENT } from "../useragent";

export interface MeteoData {
  /** 90-day daily arrays — index 0 is oldest, last index is most recent */
  daily: {
    time: string[];
    temperature_2m_max: (number | null)[];
    precipitation_sum: (number | null)[];
    wind_speed_10m_max: (number | null)[];   // km/h
    et0_fao_evapotranspiration: (number | null)[];  // mm
  };
  /** Surface elevation in metres (SRTM, included in Open-Meteo response) */
  elevation: number;
}

/**
 * Fetch 90 days of historical weather data from Open-Meteo.
 * Free, no API key, global coverage based on ERA5 reanalysis.
 * One call covers all five risk modules.
 */
export async function fetchMeteoData(
  lat: number,
  lng: number
): Promise<MeteoData | null> {
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", lat.toFixed(4));
    url.searchParams.set("longitude", lng.toFixed(4));
    url.searchParams.set(
      "daily",
      [
        "temperature_2m_max",
        "precipitation_sum",
        "wind_speed_10m_max",
        "et0_fao_evapotranspiration",
      ].join(",")
    );
    url.searchParams.set("past_days", "90");
    url.searchParams.set("forecast_days", "0");
    url.searchParams.set("timezone", "auto");

    logger.debug({ lat, lng }, "Fetching Open-Meteo 90-day weather history");

    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent":
          USER_AGENT,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`Open-Meteo returned HTTP ${res.status}`);
    }

    const data = await res.json() as {
      elevation?: number;
      daily?: {
        time: string[];
        temperature_2m_max: (number | null)[];
        precipitation_sum: (number | null)[];
        wind_speed_10m_max: (number | null)[];
        et0_fao_evapotranspiration: (number | null)[];
      };
    };

    if (!data.daily) {
      throw new Error("Open-Meteo response missing daily data");
    }

    return {
      daily: data.daily,
      elevation: data.elevation ?? 0,
    };
  } catch (err) {
    logger.warn({ err }, "Open-Meteo fetch failed — risk modules will use fallbacks");
    return null;
  }
}

// ─── Helpers used by multiple risk modules ───────────────────────────────────

/** Filter nulls and return a clean number array */
export function cleanArray(arr: (number | null)[]): number[] {
  return arr.filter((v): v is number => v !== null);
}

/** Safe average — returns null if array is empty */
export function mean(arr: number[]): number | null {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Safe sum */
export function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}
