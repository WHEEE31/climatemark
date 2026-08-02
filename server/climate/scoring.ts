import {
  CONFIDENCE_QUALITY,
  MIN_QUALITY_FOR_COMPOSITE,
  scoreToRating,
  type Hazard,
  type RiskRating,
} from '../../shared/types';

/**
 * Weights approximate relative insured loss across hazard classes. They are
 * defensible defaults, not calibrated coefficients — see README "Known gaps".
 */
export const HAZARD_WEIGHTS: Record<Hazard['id'], number> = {
  flood: 0.25,
  storms: 0.22,
  wildfire: 0.2,
  heat: 0.14,
  airQuality: 0.1,
  drought: 0.09,
};

export interface CompositeOutcome {
  compositeScore: number | null;
  compositeRating: RiskRating | null;
  dataQuality: number;
  suppressedReason: string | null;
}

/**
 * Weighted mean of hazard scores, gated on data quality.
 *
 * A composite is only produced when enough of its weight rests on real data.
 * Below the threshold the number would imply a precision the inputs don't
 * support, so we return null and let the UI show the breakdown instead. This
 * is the single most important guard in the app: it's what stops a
 * latitude-based guess from rendering identically to a FEMA flood zone.
 */
export function computeComposite(hazards: Hazard[]): CompositeOutcome {
  if (hazards.length === 0) {
    return {
      compositeScore: null,
      compositeRating: null,
      dataQuality: 0,
      suppressedReason: 'No hazard data could be retrieved for this location.',
    };
  }

  const totalWeight = hazards.reduce((sum, h) => sum + h.weight, 0);
  if (totalWeight <= 0) {
    return {
      compositeScore: null,
      compositeRating: null,
      dataQuality: 0,
      suppressedReason: 'No hazard data could be retrieved for this location.',
    };
  }

  // Quality = weighted share of the assessment backed by real data.
  const dataQuality =
    hazards.reduce((sum, h) => sum + h.weight * CONFIDENCE_QUALITY[h.confidence], 0) /
    totalWeight;

  const weighted =
    hazards.reduce((sum, h) => sum + h.score * h.weight, 0) / totalWeight;
  const score = Math.round(Math.max(0, Math.min(100, weighted)));

  if (dataQuality < MIN_QUALITY_FOR_COMPOSITE) {
    const estimated = hazards.filter((h) => h.confidence === 'estimated');
    return {
      compositeScore: null,
      compositeRating: null,
      dataQuality,
      suppressedReason:
        estimated.length > 0
          ? `Too much of this assessment rests on regional approximation (${estimated
              .map((h) => h.name.toLowerCase())
              .join(', ')}). A single combined score would imply precision the data doesn't support.`
          : "Data coverage at this location is too thin to support a single combined score.",
    };
  }

  return {
    compositeScore: score,
    compositeRating: scoreToRating(score),
    dataQuality,
    suppressedReason: null,
  };
}

/**
 * Pick the hazard that should drive the decision.
 *
 * Deliberately not the highest raw score. A 60 read straight off a flood-zone
 * polygon is a firmer basis for action than a 70 inferred from latitude, so
 * severity is discounted by confidence. Weight breaks near-ties toward the
 * hazard that causes more financial damage.
 */
export function selectDominantHazard(hazards: Hazard[]): Hazard {
  if (hazards.length === 0) throw new Error('selectDominantHazard requires at least one hazard');

  return hazards.reduce((best, current) => {
    const rank = (h: Hazard) =>
      h.score * CONFIDENCE_QUALITY[h.confidence] + h.weight * 10;
    return rank(current) > rank(best) ? current : best;
  });
}

export function buildSummary(
  resolvedAddress: string,
  dominant: Hazard,
  composite: CompositeOutcome,
  hazardCount: number,
): string {
  const lead =
    dominant.score >= 50
      ? `${dominant.name} is the defining risk at ${resolvedAddress}, rated ${dominant.rating.toLowerCase()} (${dominant.score}/100).`
      : `No severe hazard stands out at ${resolvedAddress}. The highest exposure is ${dominant.name.toLowerCase()} at ${dominant.score}/100 (${dominant.rating.toLowerCase()}).`;

  const basis =
    dominant.confidence === 'measured'
      ? 'That reading comes from an official hazard dataset covering this exact location.'
      : dominant.confidence === 'modeled'
        ? 'That reading is modeled from observed climate records for this location.'
        : 'That reading is a regional approximation — treat it as directional only.';

  const tail =
    composite.compositeScore !== null
      ? `Across all ${hazardCount} hazards the combined score is ${composite.compositeScore}/100 (${composite.compositeRating?.toLowerCase()}).`
      : 'A combined score is withheld here because too much of the assessment rests on approximation.';

  return `${lead} ${basis} ${tail}`;
}
