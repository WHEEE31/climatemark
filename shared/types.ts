/**
 * Shared contract between browser and server.
 *
 * The central design decision here is that every number carries its own
 * provenance. A score derived from a measured flood-zone polygon and a score
 * derived from a latitude heuristic are not the same kind of claim, and the
 * type system refuses to let them be rendered identically.
 */

export const RISK_RATINGS = [
  'Minimal',
  'Low',
  'Moderate',
  'High',
  'Very High',
  'Extreme',
] as const;
export type RiskRating = (typeof RISK_RATINGS)[number];

/**
 * How much this number is worth.
 *
 * measured  — read from an authoritative dataset covering this exact point
 *             (FEMA flood zone polygon, USDA wildfire hazard raster).
 * modeled   — derived from real observations at this location, but through our
 *             own model rather than an official hazard designation
 *             (ERA5 reanalysis, CAMS air quality).
 * estimated — a regional or latitude-based heuristic. Better than nothing,
 *             but it is a guess, and it must never look like a measurement.
 */
export const CONFIDENCE_TIERS = ['measured', 'modeled', 'estimated'] as const;
export type Confidence = (typeof CONFIDENCE_TIERS)[number];

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  measured: 'Measured',
  modeled: 'Modeled',
  estimated: 'Estimated',
};

export const CONFIDENCE_BLURB: Record<Confidence, string> = {
  measured: 'Read directly from an official hazard dataset for this location.',
  modeled: 'Computed from observed climate records for this location.',
  estimated: 'Regional approximation — no location-specific dataset available here.',
};

/** Numeric weight used when deciding whether a composite score is defensible. */
export const CONFIDENCE_QUALITY: Record<Confidence, number> = {
  measured: 1.0,
  modeled: 0.7,
  estimated: 0.25,
};

export type HazardId =
  | 'flood'
  | 'storms'
  | 'wildfire'
  | 'heat'
  | 'drought'
  | 'airQuality';

export interface Hazard {
  id: HazardId;
  name: string;
  score: number;
  rating: RiskRating;
  confidence: Confidence;
  description: string;
  dataSource: string;
  /** Share of the composite this hazard is responsible for, 0–1. */
  weight: number;
}

export type Priority = 'High' | 'Medium' | 'Low';

export interface Recommendation {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  estimatedCost: string;
  /** Which hazard triggered it — lets the UI group actions by cause. */
  hazard: HazardId | 'general';
  /** True when a property detail the user supplied changed this advice. */
  propertySpecific: boolean;
}

/** Optional property attributes. Absent by default; each one sharpens advice. */
export interface PropertyProfile {
  yearBuilt?: 'pre1980' | '1980to2000' | 'post2000' | 'unknown';
  roof?: 'asphalt' | 'metalOrTile' | 'woodShake' | 'flat' | 'unknown';
  foundation?: 'slab' | 'crawlspace' | 'basement' | 'raised' | 'unknown';
  stories?: '1' | '2plus' | 'unknown';
}

/** Long-run climate signal — the 30-year view, not the last 90 days. */
export interface ClimateOutlook {
  confidence: Confidence;
  baselinePeriod: string;
  projectionPeriod: string;
  /** Mean daily maximum temperature, °C. */
  baselineMaxTempC: number;
  projectedMaxTempC: number;
  /** Days per year at or above 32 °C / 90 °F. */
  baselineHotDays: number;
  projectedHotDays: number;
  /** Annual precipitation, mm. */
  baselinePrecipMm: number;
  projectedPrecipMm: number;
  note: string;
}

/** Per-source outcome, so the UI can show real progress instead of theater. */
export interface SourceStatus {
  name: string;
  status: 'ok' | 'unavailable';
  detail?: string;
}

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface AssessmentResult {
  query: string;
  resolvedAddress: string;
  coordinates: Coordinates;
  country: string;
  countryCode: string;

  /** The hazard that should drive the user's decision. Always present. */
  dominantHazard: Hazard;
  hazards: Hazard[];

  /**
   * Null when data quality is too thin to defend a single number. The UI shows
   * the hazard breakdown instead of a composite in that case, rather than
   * inventing false precision.
   */
  compositeScore: number | null;
  compositeRating: RiskRating | null;
  /** 0–1. Weighted share of the assessment backed by real data. */
  dataQuality: number;
  compositeSuppressedReason: string | null;

  outlook: ClimateOutlook | null;
  recommendations: Recommendation[];
  sources: SourceStatus[];
  summary: string;
  generatedAt: string;
}

export interface AssessmentInput {
  address: string;
  property?: PropertyProfile;
}

export interface AddressCandidate {
  label: string;
  lat: number;
  lng: number;
  countryCode: string;
}

export interface ErrorResponse {
  error: string;
}

export const ADDRESS_MIN_LENGTH = 4;

/** Below this, a single composite number is not defensible. */
export const MIN_QUALITY_FOR_COMPOSITE = 0.45;

export function scoreToRating(score: number): RiskRating {
  if (score >= 85) return 'Extreme';
  if (score >= 70) return 'Very High';
  if (score >= 50) return 'High';
  if (score >= 30) return 'Moderate';
  if (score >= 15) return 'Low';
  return 'Minimal';
}
