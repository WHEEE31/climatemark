import { logger } from '../logger';
import type { ClimateOutlook, Confidence } from '../../shared/types';

/**
 * The 30-year view.
 *
 * The original scoring used a rolling 90-day weather window, which is a
 * category error: 90 days measures weather, and a wet spring made a house look
 * flood-prone. A buyer signing a 30-year mortgage is asking a 30-year question.
 *
 * This module answers it with two windows:
 *   - baseline:   1991–2020 ERA5 reanalysis, the standard climate normal period
 *   - projection: 2036–2065 from Open-Meteo's CMIP6 downscaled climate models
 *
 * Both are free and keyless. If either is unavailable the outlook is omitted
 * entirely rather than substituted with a guess.
 */

const BASELINE_START = '1991-01-01';
const BASELINE_END = '2020-12-31';
const PROJECTION_START = '2036-01-01';
const PROJECTION_END = '2065-12-31';

const HOT_DAY_THRESHOLD_C = 32;

/** These are stable for decades — cache hard. */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map<string, { value: ClimateOutlook | null; expires: number }>();

interface DailySeries {
  maxTemps: number[];
  precip: number[];
}

function summarize(series: DailySeries, years: number) {
  const validTemps = series.maxTemps.filter((v) => Number.isFinite(v));
  const validPrecip = series.precip.filter((v) => Number.isFinite(v));

  const meanMax =
    validTemps.length > 0
      ? validTemps.reduce((a, b) => a + b, 0) / validTemps.length
      : Number.NaN;

  const hotDays =
    validTemps.length > 0
      ? validTemps.filter((v) => v >= HOT_DAY_THRESHOLD_C).length / years
      : Number.NaN;

  const annualPrecip =
    validPrecip.length > 0 ? validPrecip.reduce((a, b) => a + b, 0) / years : Number.NaN;

  return { meanMax, hotDays, annualPrecip };
}

async function fetchSeries(url: URL, label: string): Promise<DailySeries> {
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(25_000),
  });

  if (!res.ok) throw new Error(`${label} responded with ${res.status}`);

  const data = (await res.json()) as {
    daily?: { temperature_2m_max?: (number | null)[]; precipitation_sum?: (number | null)[] };
  };

  const maxTemps = (data.daily?.temperature_2m_max ?? []).filter(
    (v): v is number => typeof v === 'number',
  );
  const precip = (data.daily?.precipitation_sum ?? []).filter(
    (v): v is number => typeof v === 'number',
  );

  if (maxTemps.length === 0) throw new Error(`${label} returned no temperature data`);

  return { maxTemps, precip };
}

function baselineUrl(lat: number, lng: number): URL {
  const url = new URL('https://archive-api.open-meteo.com/v1/archive');
  url.searchParams.set('latitude', lat.toFixed(3));
  url.searchParams.set('longitude', lng.toFixed(3));
  url.searchParams.set('start_date', BASELINE_START);
  url.searchParams.set('end_date', BASELINE_END);
  url.searchParams.set('daily', 'temperature_2m_max,precipitation_sum');
  url.searchParams.set('timezone', 'UTC');
  return url;
}

function projectionUrl(lat: number, lng: number): URL {
  const url = new URL('https://climate-api.open-meteo.com/v1/climate');
  url.searchParams.set('latitude', lat.toFixed(3));
  url.searchParams.set('longitude', lng.toFixed(3));
  url.searchParams.set('start_date', PROJECTION_START);
  url.searchParams.set('end_date', PROJECTION_END);
  // Multi-model mean smooths individual model bias.
  url.searchParams.set('models', 'MRI_AGCM3_2_S,EC_Earth3P_HR');
  url.searchParams.set('daily', 'temperature_2m_max,precipitation_sum');
  return url;
}

export async function getClimateOutlook(
  lat: number,
  lng: number,
): Promise<ClimateOutlook | null> {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.value;

  try {
    const [baseline, projection] = await Promise.all([
      fetchSeries(baselineUrl(lat, lng), 'ERA5 archive'),
      fetchSeries(projectionUrl(lat, lng), 'CMIP6 climate API'),
    ]);

    const base = summarize(baseline, 30);
    const proj = summarize(projection, 30);

    if (!Number.isFinite(base.meanMax) || !Number.isFinite(proj.meanMax)) {
      throw new Error('Insufficient data to summarize');
    }

    const warming = proj.meanMax - base.meanMax;
    const extraHotDays = Math.round(proj.hotDays - base.hotDays);
    const precipChangePct =
      Number.isFinite(base.annualPrecip) && base.annualPrecip > 0
        ? ((proj.annualPrecip - base.annualPrecip) / base.annualPrecip) * 100
        : Number.NaN;

    const parts: string[] = [
      `Average daily high is projected to rise ${warming.toFixed(1)} °C by mid-century.`,
    ];
    if (Number.isFinite(extraHotDays) && extraHotDays !== 0) {
      parts.push(
        extraHotDays > 0
          ? `That adds roughly ${extraHotDays} days a year above 32 °C.`
          : `Days above 32 °C are projected to fall by about ${Math.abs(extraHotDays)} a year.`,
      );
    }
    if (Number.isFinite(precipChangePct) && Math.abs(precipChangePct) >= 3) {
      parts.push(
        `Annual precipitation shifts about ${precipChangePct > 0 ? '+' : ''}${precipChangePct.toFixed(0)}%.`,
      );
    }

    const outlook: ClimateOutlook = {
      // Downscaled multi-model projections are a model result, never a measurement.
      confidence: 'modeled' as Confidence,
      baselinePeriod: '1991–2020',
      projectionPeriod: '2036–2065',
      baselineMaxTempC: Number(base.meanMax.toFixed(1)),
      projectedMaxTempC: Number(proj.meanMax.toFixed(1)),
      baselineHotDays: Math.round(base.hotDays),
      projectedHotDays: Math.round(proj.hotDays),
      baselinePrecipMm: Math.round(base.annualPrecip),
      projectedPrecipMm: Math.round(proj.annualPrecip),
      note: parts.join(' '),
    };

    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { value: outlook, expires: Date.now() + CACHE_TTL_MS });

    return outlook;
  } catch (err) {
    // Omit the outlook rather than substituting a guess.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), lat, lng },
      'Climate outlook unavailable',
    );
    return null;
  }
}
