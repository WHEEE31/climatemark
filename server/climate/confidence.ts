import type { Confidence } from '../../shared/types';

/**
 * Map a hazard module's reported data source onto a confidence tier.
 *
 * Doing this centrally rather than inside each scoring module means one place
 * defines what counts as a measurement, and adding a new dataset can't
 * accidentally inherit an unearned confidence level. Anything unrecognised
 * falls to `estimated` — the pessimistic default is the safe one.
 */

const MEASURED = [
  'FEMA National Flood Hazard Layer',
  'USDA Forest Service Wildfire Hazard Potential',
  'US Drought Monitor',
  'NOAA National Weather Service (NWS)',
];

const MODELED = [
  'ERA5',
  'Open-Meteo Historical Weather API',
  'Open-Meteo Elevation',
  'Copernicus CAMS',
  'Open-Meteo Air Quality API',
  'NOAA Climate Divisional Data',
];

const ESTIMATED_MARKERS = [
  'Climatological estimate',
  'latitude-based',
  'data unavailable',
  'Estimate (',
];

export function classifyConfidence(dataSource: string): Confidence {
  const src = dataSource.toLowerCase();

  // Explicit estimate markers win outright — a source string can name a real
  // dataset and still be reporting a fallback heuristic.
  if (ESTIMATED_MARKERS.some((m) => src.includes(m.toLowerCase()))) {
    return 'estimated';
  }
  if (MEASURED.some((m) => src.includes(m.toLowerCase()))) return 'measured';
  if (MODELED.some((m) => src.includes(m.toLowerCase()))) return 'modeled';

  return 'estimated';
}

/**
 * Most authoritative hazard layers are US-only. Outside their coverage the
 * scoring modules silently fall back to climatology, so a non-US assessment
 * genuinely is a weaker claim — this makes that explicit rather than letting
 * it hide behind an identical-looking gauge.
 */
export function downgradeOutsideCoverage(
  confidence: Confidence,
  isUS: boolean,
  usOnlySource: boolean,
): Confidence {
  if (usOnlySource && !isUS && confidence === 'measured') return 'modeled';
  return confidence;
}
