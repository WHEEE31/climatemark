import { logger } from "../logger";
import { forwardLookup, reverseLookup, type PlaceResult } from "./providers";


export interface GeocodedLocation {
  lat: number;
  lng: number;
  normalizedAddress: string;
  county: string;
  state: string;
  stateCode: string;
  fips: string;
  country: string;
  countryCode: string; // ISO 3166-1 alpha-2 uppercase
  isUS: boolean;
}

/**
 * Geocode an address, or a bare "lat, lng" coordinate string from a globe pin.
 * Runs through the provider chain in ./providers (Nominatim, then Photon),
 * falling back to raw coordinates so an assessment is always possible.
 */
export async function geocodeAddress(
  address: string
): Promise<GeocodedLocation | null> {
  // ── 1. Detect bare coordinate input ("lat, lng") from a globe pin ─────────
  const coordMatch = address.trim().match(/^(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]);
    const lng = parseFloat(coordMatch[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      logger.debug({ lat, lng }, "Input looks like coordinates — using directly");
      const outcome = await reverseLookup(lat, lng);
      if (outcome.place) return toLocation(outcome.place);
      return coordFallback(lat, lng, address);
    }
  }

  // ── 2. Forward geocode through the provider chain ────────────────────────
  logger.debug({ address }, "Geocoding address");
  const outcome = await forwardLookup(address);

  if (outcome.place) return toLocation(outcome.place);

  if (outcome.allProvidersFailed) {
    logger.error({ address }, "Every geocoding provider failed");
  } else {
    logger.warn({ address }, "No geocoder matches found");
  }
  return null;
}

function toLocation(place: PlaceResult): GeocodedLocation {
  return {
    lat: place.lat,
    lng: place.lng,
    normalizedAddress: place.normalizedAddress,
    county: place.county,
    state: place.state,
    stateCode: place.state,
    fips: "", // not available outside US Census data
    country: place.country,
    countryCode: place.countryCode,
    isUS: place.countryCode === "US",
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal location object built from raw coordinates — used when the user
 *  supplies a "lat, lng" string directly (globe pin with no address). */

function coordFallback(lat: number, lng: number, rawInput: string): GeocodedLocation {
  return {
    lat,
    lng,
    normalizedAddress: rawInput,
    county: "",
    state: "",
    stateCode: "",
    fips: "",
    country: "",
    countryCode: "",
    isUS: false,
  };
}
