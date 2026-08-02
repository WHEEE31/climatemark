import { Router, type Request, type Response } from 'express';

import { logger } from './logger';
import { geocodeAddress } from './climate/geocode';
import { forwardLookup, reverseLookup } from './climate/providers';
import { fetchMeteoData } from './climate/openmeteo';
import { getFloodRisk } from './climate/flood';
import { getDroughtRisk } from './climate/drought';
import { getStormRisk } from './climate/storms';
import { getWildfireRisk } from './climate/wildfire';
import { getHeatRisk } from './climate/heat';
import { getAirQualityRisk } from './climate/airquality';
import { getClimateOutlook } from './climate/climatology';
import { classifyConfidence, downgradeOutsideCoverage } from './climate/confidence';
import {
  HAZARD_WEIGHTS,
  buildSummary,
  computeComposite,
  selectDominantHazard,
} from './climate/scoring';
import { generateRecommendations } from './climate/recommendations';
import {
  ADDRESS_MIN_LENGTH,
  scoreToRating,
  type AssessmentResult,
  type Hazard,
  type HazardId,
  type PropertyProfile,
  type SourceStatus,
} from '../shared/types';

export const apiRouter: Router = Router();

apiRouter.get('/healthz', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

/** Hazard display names and whether the authoritative layer is US-only. */
const HAZARD_META: Record<HazardId, { name: string; usOnly: boolean }> = {
  flood: { name: 'Flood', usOnly: true },
  storms: { name: 'Severe storms', usOnly: true },
  wildfire: { name: 'Wildfire', usOnly: true },
  heat: { name: 'Extreme heat', usOnly: false },
  drought: { name: 'Drought', usOnly: true },
  airQuality: { name: 'Air quality', usOnly: false },
};

interface RawFactor {
  score: number;
  rating: string;
  description: string;
  dataSource: string;
}

function toHazard(id: HazardId, raw: RawFactor, isUS: boolean): Hazard {
  const meta = HAZARD_META[id];
  const base = classifyConfidence(raw.dataSource);

  return {
    id,
    name: meta.name,
    score: Math.round(Math.max(0, Math.min(100, raw.score))),
    rating: scoreToRating(raw.score),
    confidence: downgradeOutsideCoverage(base, isUS, meta.usOnly),
    description: raw.description,
    dataSource: raw.dataSource,
    weight: HAZARD_WEIGHTS[id],
  };
}

/** Address autocomplete — lets the user confirm the location before scoring. */
apiRouter.get('/geocode', async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();

  if (q.length < ADDRESS_MIN_LENGTH) {
    res.json({ candidates: [] });
    return;
  }

  const outcome = await forwardLookup(q);

  if (!outcome.place) {
    res.json({ candidates: [] });
    return;
  }

  res.json({
    candidates: [
      {
        label: outcome.place.normalizedAddress,
        lat: outcome.place.lat,
        lng: outcome.place.lng,
        countryCode: outcome.place.countryCode,
      },
    ],
  });
});

apiRouter.get('/reverse-geocode', async (req: Request, res: Response) => {
  const lat = Number.parseFloat(String(req.query.lat ?? ''));
  const lng = Number.parseFloat(String(req.query.lng ?? ''));

  if (Number.isNaN(lat) || Number.isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    res.status(400).json({ error: 'Valid lat and lng query params are required' });
    return;
  }

  const outcome = await reverseLookup(lat, lng);
  res.json({
    address: outcome.place?.normalizedAddress ?? null,
    countryCode: outcome.place?.countryCode ?? null,
    coords: { lat, lng },
    lookupFailed: outcome.allProvidersFailed,
  });
});

apiRouter.post('/assess', async (req: Request, res: Response) => {
  const body = req.body as { address?: unknown; property?: PropertyProfile } | undefined;
  const address = typeof body?.address === 'string' ? body.address.trim() : '';
  const property: PropertyProfile = body?.property ?? {};

  if (address.length < ADDRESS_MIN_LENGTH) {
    res.status(400).json({ error: 'Enter an address, or a "latitude, longitude" pair.' });
    return;
  }

  const sources: SourceStatus[] = [];
  const record = (name: string, ok: boolean, detail?: string) =>
    sources.push({ name, status: ok ? 'ok' : 'unavailable', detail });

  try {
    const location = await geocodeAddress(address);
    if (!location) {
      res.status(422).json({
        error: `Could not locate "${address}". Add more detail — street, city, and country.`,
      });
      return;
    }
    record('Geocoding', true, location.normalizedAddress);

    const meteo = await fetchMeteoData(location.lat, location.lng);
    record('Open-Meteo observations', meteo !== null);

    const { lat, lng, isUS } = location;

    // Every hazard module already degrades internally, so a rejection here is
    // genuinely exceptional — settle rather than fail the whole assessment.
    const [flood, storms, wildfire, heat, drought, airQuality, outlook] =
      await Promise.allSettled([
        getFloodRisk(lat, lng, isUS, meteo),
        getStormRisk(lat, lng, isUS, meteo),
        getWildfireRisk(lat, lng, isUS, meteo),
        getHeatRisk(lat, lng, isUS, meteo),
        getDroughtRisk(lat, lng, isUS, meteo),
        getAirQualityRisk(lat, lng),
        getClimateOutlook(lat, lng),
      ]);

    const hazards: Hazard[] = [];
    const collect = (id: HazardId, settled: PromiseSettledResult<RawFactor>) => {
      if (settled.status === 'fulfilled') {
        const hazard = toHazard(id, settled.value, isUS);
        hazards.push(hazard);
        record(
          `${HAZARD_META[id].name} — ${settled.value.dataSource}`,
          true,
          hazard.confidence,
        );
      } else {
        record(HAZARD_META[id].name, false, 'scoring failed');
      }
    };

    collect('flood', flood as PromiseSettledResult<RawFactor>);
    collect('storms', storms as PromiseSettledResult<RawFactor>);
    collect('wildfire', wildfire as PromiseSettledResult<RawFactor>);
    collect('heat', heat as PromiseSettledResult<RawFactor>);
    collect('drought', drought as PromiseSettledResult<RawFactor>);
    collect('airQuality', airQuality as PromiseSettledResult<RawFactor>);

    if (hazards.length === 0) {
      res.status(502).json({
        error: 'No hazard data could be retrieved for this location. Please try again shortly.',
      });
      return;
    }

    const climateOutlook =
      outlook.status === 'fulfilled' ? outlook.value : null;
    record('CMIP6 climate projection', climateOutlook !== null);

    const composite = computeComposite(hazards);
    const dominant = selectDominantHazard(hazards);

    const scores = Object.fromEntries(
      (Object.keys(HAZARD_META) as HazardId[]).map((id) => [
        id,
        hazards.find((h) => h.id === id)?.score ?? 0,
      ]),
    ) as Record<HazardId, number>;

    const result: AssessmentResult = {
      query: address,
      resolvedAddress: location.normalizedAddress,
      coordinates: { lat, lng },
      country: location.country,
      countryCode: location.countryCode,
      dominantHazard: dominant,
      hazards: [...hazards].sort((a, b) => b.score - a.score),
      compositeScore: composite.compositeScore,
      compositeRating: composite.compositeRating,
      dataQuality: Number(composite.dataQuality.toFixed(2)),
      compositeSuppressedReason: composite.suppressedReason,
      outlook: climateOutlook,
      recommendations: generateRecommendations(scores, property),
      sources,
      summary: buildSummary(location.normalizedAddress, dominant, composite, hazards.length),
      generatedAt: new Date().toISOString(),
    };

    logger.info(
      {
        address: location.normalizedAddress,
        dominant: dominant.id,
        composite: composite.compositeScore,
        quality: result.dataQuality,
      },
      'Assessment complete',
    );

    res.json(result);
  } catch (err) {
    logger.error({ err, address }, 'Assessment failed');
    res.status(502).json({
      error: 'An upstream data service is unavailable right now. Please try again shortly.',
    });
  }
});
