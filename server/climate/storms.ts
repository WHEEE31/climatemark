import { logger } from "../logger";
import { type MeteoData, cleanArray } from "./openmeteo";
import { USER_AGENT } from "../useragent";

export interface StormRiskResult {
  score: number;
  rating: string;
  description: string;
  activeAlerts: number;
  gridOffice: string;
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

export async function getStormRisk(
  lat: number,
  lng: number,
  isUS: boolean,
  meteo: MeteoData | null
): Promise<StormRiskResult> {
  // US: NOAA NWS gives the most accurate storm data (office baselines + live alerts)
  if (isUS) {
    try {
      return await getUSStormRisk(lat, lng);
    } catch (err) {
      logger.warn({ err }, "NOAA NWS unavailable — falling back to Open-Meteo for storms");
    }
  }

  // Global: combine geographic baseline + Open-Meteo wind/precip
  return getGlobalStormRisk(lat, lng, meteo);
}

// ─── US: NOAA NWS ─────────────────────────────────────────────────────────────

const OFFICE_BASELINES: Record<string, number> = {
  MOB: 82, LIX: 82, CRP: 82, HGX: 80, TAE: 78, JAX: 78, MFL: 85,
  OUN: 80, DDC: 75, ICT: 75, LMK: 65, JAN: 70,
  AKQ: 68, PHI: 62, OKX: 60, BOX: 58,
  CAE: 68, GSP: 60, RAH: 62, ILM: 72,
  IND: 58, IWX: 60, DTX: 55, GRR: 50, MKX: 55, MPX: 52, LOT: 57, LSX: 60, SGF: 68, EAX: 65,
  UNR: 55, FGF: 50, ABR: 55, LBF: 60, OAX: 68, TOP: 70, BYZ: 30,
  BOU: 40, PUB: 45, GJT: 30, SLC: 25, VEF: 30,
  STO: 25, LOX: 20, SGX: 18, MTR: 22, SEW: 30, PQR: 28, MFR: 25, OTX: 28,
  PSR: 35, TWC: 40, EPZ: 38, ABQ: 35,
};

async function getUSStormRisk(lat: number, lng: number): Promise<StormRiskResult> {
  let gridOffice = "";
  let activeAlerts = 0;

  const pointRes = await fetch(
    `https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`,
    { headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" }, signal: AbortSignal.timeout(10000) }
  );

  if (pointRes.ok) {
    const pointData = await pointRes.json() as any;
    const props = pointData?.properties;
    gridOffice = props?.cwa ?? "";

    const zone = (props?.forecastZone ?? props?.county ?? "").split("/").pop() ?? "";
    if (zone) {
      try {
        const alertRes = await fetch(
          `https://api.weather.gov/alerts/active?zone=${zone}`,
          { headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" }, signal: AbortSignal.timeout(8000) }
        );
        if (alertRes.ok) {
          const alertData = await alertRes.json() as any;
          activeAlerts = (alertData?.features ?? []).filter(
            (f: any) => f?.properties?.severity === "Severe" || f?.properties?.severity === "Extreme"
          ).length;
        }
      } catch { /* alerts optional */ }
    }
  }

  const baseline = OFFICE_BASELINES[gridOffice] ?? 50;
  const score = Math.min(baseline + Math.min(activeAlerts * 5, 15), 100);

  return {
    score,
    rating: scoreToRating(score),
    description: buildUSDescription(score, activeAlerts),
    activeAlerts,
    gridOffice: gridOffice || "Unknown",
    dataSource: "NOAA National Weather Service (NWS)",
  };
}

function buildUSDescription(score: number, alerts: number): string {
  const alertText = alerts > 0 ? ` There ${alerts === 1 ? "is" : "are"} currently ${alerts} active NWS severe weather alert${alerts > 1 ? "s" : ""} in this area.` : "";
  if (score >= 85) return `This location has very high exposure to severe weather events — including hurricanes, tornadoes, or major thunderstorms — based on historical NOAA climate patterns.${alertText} Structural hardening and emergency preparedness are strongly recommended.`;
  if (score >= 65) return `Severe weather risk is elevated. The region regularly experiences significant storms, including high winds, hail, or cyclonic systems.${alertText} Storm shutters, roof reinforcement, and backup power can meaningfully reduce vulnerability.`;
  if (score >= 40) return `This location has moderate severe weather exposure. Significant storms occur periodically.${alertText} Standard storm preparation and comprehensive homeowners insurance is advised.`;
  if (score >= 20) return `Severe storm risk is relatively low based on NOAA historical data. Major weather events are infrequent but not impossible.${alertText}`;
  return `Minimal severe storm activity based on NOAA climate records. The area's geography provides natural protection from most major weather systems.${alertText}`;
}

// ─── Global storm risk ────────────────────────────────────────────────────────

function getGlobalStormRisk(lat: number, lng: number, meteo: MeteoData | null): StormRiskResult {
  // Layer 1: geographic baseline (tropical cyclone basins + mid-latitude storm tracks)
  const geoScore = geographicStormBaseline(lat, lng);

  // Layer 2: observed recent wind/precip from Open-Meteo
  let meteoBoost = 0;
  if (meteo?.daily?.wind_speed_10m_max) {
    const winds = cleanArray(meteo.daily.wind_speed_10m_max).slice(-30);
    const maxWind = winds.length > 0 ? Math.max(...winds) : 0;
    const precips = cleanArray(meteo.daily.precipitation_sum).slice(-30);
    const maxPrecip = precips.length > 0 ? Math.max(...precips) : 0;

    // Strong observed wind or extreme daily rainfall as evidence of storm activity
    if (maxWind > 80)       meteoBoost += 12; // hurricane/typhoon force
    else if (maxWind > 60)  meteoBoost += 8;
    else if (maxWind > 40)  meteoBoost += 4;

    if (maxPrecip > 100)    meteoBoost += 8;  // extreme precipitation day
    else if (maxPrecip > 50) meteoBoost += 4;
  }

  const score = Math.min(geoScore + meteoBoost, 100);
  const { region, source } = describeRegion(lat, lng);

  return {
    score,
    rating: scoreToRating(score),
    description: buildGlobalDescription(score, region),
    activeAlerts: 0,
    gridOffice: region,
    dataSource: `Open-Meteo Historical Weather API + Geographic Storm Climatology (${source})`,
  };
}

/**
 * Geographic baseline storm score based on tropical cyclone basin exposure,
 * mid-latitude tornado / severe thunderstorm climate zones, and extratropical
 * storm track intensity.
 */
function geographicStormBaseline(lat: number, lng: number): number {
  const absLat = Math.abs(lat);

  // ── Tropical cyclone basins (primary formation zones) ──────────────────────
  // Bay of Bengal — India, Bangladesh, Myanmar, Sri Lanka (very active)
  if (lat > 6 && lat < 25 && lng > 78 && lng < 100) return 76;

  // Western Pacific — Philippines, Japan, Vietnam, SE China (most active basin)
  if (lat > 5 && lat < 32 && lng > 115 && lng < 160) return 82;

  // Gulf of Mexico + Caribbean
  if (lat > 10 && lat < 30 && lng > -100 && lng < -58) return 78;

  // Eastern Pacific — Mexico west coast, Central America
  if (lat > 6 && lat < 22 && lng > -120 && lng < -85) return 68;

  // South Indian Ocean — Madagascar, Mozambique, Réunion
  if (lat < -5 && lat > -28 && lng > 45 && lng < 95) return 66;

  // South Pacific — Fiji, Vanuatu, NE Australia
  if (lat < -5 && lat > -25 && lng > 155 && lng <= 180) return 64;
  if (lat < -5 && lat > -25 && lng >= -180 && lng < -160) return 58;

  // Arabian Sea (moderate, cyclones track toward Oman/Yemen/India)
  if (lat > 8 && lat < 24 && lng > 55 && lng < 78) return 55;

  // ── Mid-latitude severe weather zones ─────────────────────────────────────
  // Bangladesh / India (some of world's most intense tornadoes)
  if (lat > 22 && lat < 28 && lng > 85 && lng < 92) return 65;

  // South-central South America (Argentina tornado zone)
  if (lat < -25 && lat > -42 && lng > -68 && lng < -56) return 55;

  // Southern Europe (Med. cyclones — Medicanes)
  if (lat > 35 && lat < 48 && lng > -5 && lng < 30) return 38;

  // Western / Central Europe extratropical storms
  if (lat > 45 && lat < 62 && lng > -10 && lng < 25) return 42;

  // East Asia extratropical (Japan, Korea, NE China)
  if (lat > 32 && lat < 50 && lng > 120 && lng < 145) return 48;

  // South Africa (subtropical storm track)
  if (lat < -25 && lat > -38 && lng > 15 && lng < 35) return 40;

  // Northern Europe / North Atlantic storms
  if (lat > 55 && lat < 72 && lng > -25 && lng < 30) return 45;

  // ── Low-risk zones ─────────────────────────────────────────────────────────
  // Equatorial calm zone (ITCZ — little organised storm activity)
  if (absLat < 5) return 22;

  // Subtropical highs (Sahara, Arabian desert, subtropical Pacific)
  if (absLat > 20 && absLat < 35 && (lng > 0 && lng < 60)) return 20; // Middle East / N Africa

  // Polar regions
  if (absLat > 70) return 18;

  // Default mid-latitude
  return 35;
}

function describeRegion(lat: number, lng: number): { region: string; source: string } {
  const absLat = Math.abs(lat);
  if (lat > 5 && lat < 32 && lng > 115 && lng < 160) return { region: "Western Pacific typhoon basin", source: "JTWC storm climatology" };
  if (lat > 6 && lat < 25 && lng > 78 && lng < 100) return { region: "Bay of Bengal cyclone basin", source: "IMD storm climatology" };
  if (lat > 10 && lat < 30 && lng > -100 && lng < -58) return { region: "Gulf / Caribbean hurricane basin", source: "NHC storm climatology" };
  if (lat > 6 && lat < 22 && lng > -120 && lng < -85) return { region: "Eastern Pacific hurricane basin", source: "NHC/CPHC storm climatology" };
  if (lat < -5 && lat > -28 && lng > 45 && lng < 95) return { region: "South Indian Ocean cyclone basin", source: "Météo-France/IMD climatology" };
  if (absLat > 45 && absLat < 65) return { region: "Mid-latitude storm track", source: "ECMWF storm climatology" };
  return { region: "Regional storm climatology", source: "Global storm frequency data" };
}

function buildGlobalDescription(score: number, region: string): string {
  if (score >= 85) return `This location sits within a very active storm zone (${region}). Tropical cyclones, typhoons, or severe storms regularly threaten this area. Structural reinforcement, storm shutters, and comprehensive insurance are strongly recommended.`;
  if (score >= 65) return `Significant storm risk affects this property. The ${region} sees regular tropical or severe extratropical storms, bringing high winds, storm surge, and extreme rainfall. Investing in storm resilience is advisable.`;
  if (score >= 40) return `Moderate storm exposure exists for this location. The region experiences periodic severe weather, including tropical systems at their fringes or intense mid-latitude storms. Standard storm preparation and insurance are recommended.`;
  if (score >= 20) return `Storm risk is relatively low for this location. Severe weather is infrequent but not impossible, particularly from distant tropical systems or extratropical storms in autumn and winter.`;
  return `Minimal organised severe storm activity is expected for this location based on global storm climatology. The geography provides some natural buffering from the major storm-generating regions.`;
}
