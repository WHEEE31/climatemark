import { logger } from '../logger';
import { USER_AGENT } from "../useragent";

/**
 * Geocoding with a fallback chain.
 *
 * Nominatim (OpenStreetMap) is free but strict: it requires a identifying
 * User-Agent, allows roughly one request per second, mandates that clients
 * cache results, and blocks by IP *range* — so a neighbour on your ISP abusing
 * the service can get you a 403 through no fault of your own. Depending on it
 * alone makes the app randomly unusable.
 *
 * Photon (also OpenStreetMap data, run by Komoot) needs no key and has no
 * User-Agent requirement, so it makes a good second chance. If both fail the
 * caller falls back to raw coordinates, which every scoring module accepts.
 */

export interface PlaceResult {
  lat: number;
  lng: number;
  normalizedAddress: string;
  county: string;
  state: string;
  country: string;
  countryCode: string;
}



// ─── Cache ───────────────────────────────────────────────────────────────────
// Nominatim's usage policy requires clients to cache. It also makes repeat
// lookups instant and keeps us far below the rate limit.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 1000;
const cache = new Map<string, { value: PlaceResult | null; expires: number }>();

function cacheGet(key: string): { value: PlaceResult | null } | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return undefined;
  }
  return { value: hit.value };
}

function cacheSet(key: string, value: PlaceResult | null): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

// ─── Rate limiting ───────────────────────────────────────────────────────────
// Serialise Nominatim calls at one per second, as the usage policy requires.

let nominatimChain: Promise<unknown> = Promise.resolve();

function throttleNominatim<T>(task: () => Promise<T>): Promise<T> {
  const run = nominatimChain.then(async () => {
    const result = await task();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    return result;
  });
  // Keep the chain alive even if one link rejects.
  nominatimChain = run.catch(() => undefined);
  return run;
}

// ─── Nominatim ───────────────────────────────────────────────────────────────

interface NominatimAddress {
  house_number?: string;
  road?: string;
  suburb?: string;
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  state?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
}

function formatNominatim(
  lat: number,
  lng: number,
  addr: NominatimAddress,
  displayName?: string,
): PlaceResult {
  const countryCode = (addr.country_code ?? '').toUpperCase();
  const parts: string[] = [];

  if (addr.house_number && addr.road) parts.push(`${addr.house_number} ${addr.road}`);
  else if (addr.road) parts.push(addr.road);

  const locality = addr.city ?? addr.town ?? addr.village ?? addr.suburb ?? addr.county;
  if (locality) parts.push(locality);
  if (addr.state) parts.push(addr.state);
  if (addr.postcode) parts.push(addr.postcode);
  if (countryCode !== 'US' && addr.country) parts.push(addr.country);

  return {
    lat,
    lng,
    normalizedAddress: parts.length > 0 ? parts.join(', ') : (displayName ?? ''),
    county: addr.county ?? '',
    state: addr.state ?? '',
    country: addr.country ?? '',
    countryCode,
  };
}

async function nominatimReverse(lat: number, lng: number): Promise<PlaceResult | null> {
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'en');

  const res = await throttleNominatim(() =>
    fetch(url.toString(), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    }),
  );

  if (!res.ok) throw new Error(`Nominatim responded with ${res.status}`);

  const data = (await res.json()) as {
    error?: string;
    display_name?: string;
    address?: NominatimAddress;
  };

  if (data.error || !data.address) return null;
  return formatNominatim(lat, lng, data.address, data.display_name);
}

async function nominatimForward(query: string): Promise<PlaceResult | null> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '1');

  const res = await throttleNominatim(() =>
    fetch(url.toString(), {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'Accept-Language': 'en',
      },
      signal: AbortSignal.timeout(10_000),
    }),
  );

  if (!res.ok) throw new Error(`Nominatim responded with ${res.status}`);

  const results = (await res.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
    address?: NominatimAddress;
  }>;

  if (!Array.isArray(results) || results.length === 0) return null;
  const top = results[0];
  return formatNominatim(
    Number.parseFloat(top.lat),
    Number.parseFloat(top.lon),
    top.address ?? {},
    top.display_name,
  );
}

// ─── Photon (fallback) ───────────────────────────────────────────────────────

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    housenumber?: string;
    street?: string;
    city?: string;
    district?: string;
    county?: string;
    state?: string;
    postcode?: string;
    country?: string;
    countrycode?: string;
  };
}

function formatPhoton(feature: PhotonFeature, fallbackLat: number, fallbackLng: number): PlaceResult | null {
  const p = feature.properties;
  if (!p) return null;

  const coords = feature.geometry?.coordinates;
  const lng = coords?.[0] ?? fallbackLng;
  const lat = coords?.[1] ?? fallbackLat;
  const countryCode = (p.countrycode ?? '').toUpperCase();

  const parts: string[] = [];
  if (p.housenumber && p.street) parts.push(`${p.housenumber} ${p.street}`);
  else if (p.street) parts.push(p.street);
  else if (p.name) parts.push(p.name);

  const locality = p.city ?? p.district ?? p.county;
  if (locality && !parts.includes(locality)) parts.push(locality);
  if (p.state) parts.push(p.state);
  if (p.postcode) parts.push(p.postcode);
  if (countryCode !== 'US' && p.country) parts.push(p.country);

  if (parts.length === 0) return null;

  return {
    lat,
    lng,
    normalizedAddress: parts.join(', '),
    county: p.county ?? '',
    state: p.state ?? '',
    country: p.country ?? '',
    countryCode,
  };
}

async function photonReverse(lat: number, lng: number): Promise<PlaceResult | null> {
  const url = new URL('https://photon.komoot.io/reverse');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('lang', 'en');

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`Photon responded with ${res.status}`);

  const data = (await res.json()) as { features?: PhotonFeature[] };
  const feature = data.features?.[0];
  if (!feature) return null;
  return formatPhoton(feature, lat, lng);
}

async function photonForward(query: string): Promise<PlaceResult | null> {
  const url = new URL('https://photon.komoot.io/api');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '1');
  url.searchParams.set('lang', 'en');

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`Photon responded with ${res.status}`);

  const data = (await res.json()) as { features?: PhotonFeature[] };
  const feature = data.features?.[0];
  if (!feature) return null;
  return formatPhoton(feature, 0, 0);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface LookupOutcome {
  place: PlaceResult | null;
  /** True when every provider errored — distinct from "nothing is here". */
  allProvidersFailed: boolean;
  provider: 'nominatim' | 'photon' | 'cache' | 'none';
}

async function tryProviders(
  cacheKey: string,
  attempts: Array<{ name: 'nominatim' | 'photon'; run: () => Promise<PlaceResult | null> }>,
): Promise<LookupOutcome> {
  const cached = cacheGet(cacheKey);
  if (cached) {
    return { place: cached.value, allProvidersFailed: false, provider: 'cache' };
  }

  let failures = 0;

  for (const attempt of attempts) {
    try {
      const place = await attempt.run();
      cacheSet(cacheKey, place);
      return { place, allProvidersFailed: false, provider: attempt.name };
    } catch (err) {
      failures += 1;
      logger.warn(
        { provider: attempt.name, err: err instanceof Error ? err.message : String(err) },
        'Geocoding provider failed — trying next',
      );
    }
  }

  return {
    place: null,
    allProvidersFailed: failures === attempts.length,
    provider: 'none',
  };
}

export function reverseLookup(lat: number, lng: number): Promise<LookupOutcome> {
  // Round the cache key to ~11m. Nearby clicks share an entry, which keeps us
  // well inside the usage policy without changing what the user sees.
  const key = `r:${lat.toFixed(4)},${lng.toFixed(4)}`;
  return tryProviders(key, [
    { name: 'nominatim', run: () => nominatimReverse(lat, lng) },
    { name: 'photon', run: () => photonReverse(lat, lng) },
  ]);
}

export function forwardLookup(query: string): Promise<LookupOutcome> {
  const key = `f:${query.trim().toLowerCase()}`;
  return tryProviders(key, [
    { name: 'nominatim', run: () => nominatimForward(query) },
    { name: 'photon', run: () => photonForward(query) },
  ]);
}
