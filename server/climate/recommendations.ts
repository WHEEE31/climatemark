import type {
  HazardId,
  Priority,
  PropertyProfile,
  Recommendation,
} from '../../shared/types';

/**
 * Recommendation engine.
 *
 * Two things separate this from a lookup table:
 *
 *  1. Property attributes gate and reshape advice. Telling someone with a slab
 *     foundation to elevate their utilities out of the basement is noise, and
 *     noise is how a risk product loses trust. A wood shake roof in a wildfire
 *     zone, on the other hand, is the single highest-leverage fix there is —
 *     and generic advice would never surface it.
 *
 *  2. Actions carry the score that triggered them, so ranking reflects actual
 *     exposure rather than authoring order.
 */

type Scores = Record<HazardId, number>;

interface Candidate extends Recommendation {
  weight: number;
}

function pushIf(
  list: Candidate[],
  condition: boolean,
  rec: Omit<Candidate, 'propertySpecific'> & { propertySpecific?: boolean },
): void {
  if (condition) {
    list.push({ propertySpecific: false, ...rec });
  }
}

export function generateRecommendations(
  scores: Scores,
  profile: PropertyProfile = {},
): Recommendation[] {
  const c: Candidate[] = [];
  const known = <T extends string>(v: T | undefined): v is T =>
    v !== undefined && v !== 'unknown';

  // ── Flood ──────────────────────────────────────────────────────────────────
  pushIf(c, scores.flood >= 50, {
    id: 'flood-insurance',
    hazard: 'flood',
    title: 'Get a separate flood insurance quote',
    description:
      'Homeowners policies exclude flood damage. At this exposure level a standalone NFIP or private policy is the difference between a claim and a total loss.',
    priority: 'High',
    estimatedCost: '$700–$1,500 / year',
    weight: scores.flood + 5,
  });

  // Basement advice only makes sense if there is a basement.
  pushIf(c, scores.flood >= 40 && profile.foundation === 'basement', {
    id: 'flood-elevate-utilities',
    hazard: 'flood',
    title: 'Elevate furnace, water heater, and panel above the basement floor',
    description:
      'Your basement puts the most expensive mechanical equipment at the lowest point in the house. Raising it onto platforms is the cheapest meaningful flood mitigation available.',
    priority: 'High',
    estimatedCost: '$1,500–$5,000',
    weight: scores.flood + 8,
    propertySpecific: true,
  });

  pushIf(c, scores.flood >= 40 && profile.foundation === 'crawlspace', {
    id: 'flood-crawlspace-vents',
    hazard: 'flood',
    title: 'Install engineered flood vents in the crawlspace',
    description:
      'Crawlspaces fail when trapped water forces walls inward. Engineered vents equalise pressure, and in many flood zones they lower insurance premiums enough to pay for themselves.',
    priority: 'Medium',
    estimatedCost: '$600–$2,000',
    weight: scores.flood + 3,
    propertySpecific: true,
  });

  pushIf(c, scores.flood >= 30 && !known(profile.foundation), {
    id: 'flood-grading',
    hazard: 'flood',
    title: 'Regrade soil away from the foundation and extend downspouts',
    description:
      'Most water intrusion is not river flooding — it is rainfall pooling against the wall. Six feet of downspout extension and a positive slope solve a surprising share of it.',
    priority: 'Medium',
    estimatedCost: '$200–$2,000',
    weight: scores.flood,
  });

  // ── Wildfire ───────────────────────────────────────────────────────────────
  pushIf(c, scores.wildfire >= 45 && profile.roof === 'woodShake', {
    id: 'fire-roof-replace',
    hazard: 'wildfire',
    title: 'Replace the wood shake roof — highest-leverage fix on this property',
    description:
      'Wind-borne embers, not the fire front, destroy most homes. A wood shake roof in this hazard zone is the single largest ignition surface you have; Class A roofing changes the outcome more than any other measure.',
    priority: 'High',
    estimatedCost: '$12,000–$30,000',
    weight: scores.wildfire + 25,
    propertySpecific: true,
  });

  pushIf(c, scores.wildfire >= 45, {
    id: 'fire-defensible-space',
    hazard: 'wildfire',
    title: 'Clear defensible space to 30 feet, and 100 feet if terrain allows',
    description:
      'Remove dead vegetation, prune branches clear of the roofline, and keep nothing combustible against exterior walls. This is the cheapest wildfire work with real evidence behind it.',
    priority: 'High',
    estimatedCost: 'Free–$3,000',
    weight: scores.wildfire + 6,
  });

  pushIf(c, scores.wildfire >= 55, {
    id: 'fire-ember-vents',
    hazard: 'wildfire',
    title: 'Fit 1/8-inch metal mesh over every vent and eave opening',
    description:
      'Embers enter through attic and crawlspace vents and ignite the house from inside. Fine metal mesh is inexpensive and blocks the pathway.',
    priority: 'Medium',
    estimatedCost: '$300–$1,200',
    weight: scores.wildfire + 2,
  });

  // ── Heat ───────────────────────────────────────────────────────────────────
  pushIf(c, scores.heat >= 60 && profile.yearBuilt === 'pre1980', {
    id: 'heat-insulate-old',
    hazard: 'heat',
    title: 'Audit attic insulation — pre-1980 construction is usually well under code',
    description:
      'Homes of this era were typically built to R-11 or less. Bringing the attic to current levels cuts cooling load year-round and is often the best return on any efficiency spend.',
    priority: 'High',
    estimatedCost: '$1,500–$4,000',
    weight: scores.heat + 10,
    propertySpecific: true,
  });

  pushIf(c, scores.heat >= 60, {
    id: 'heat-cooling-resilience',
    hazard: 'heat',
    title: 'Plan for cooling that survives a grid outage',
    description:
      'Heat waves and blackouts arrive together. One battery-backed room, a heat-pump upgrade, or a generator turns a dangerous week into an uncomfortable one.',
    priority: 'High',
    estimatedCost: '$500–$8,000',
    weight: scores.heat + 4,
  });

  pushIf(c, scores.heat >= 40 && profile.roof === 'flat', {
    id: 'heat-cool-roof',
    hazard: 'heat',
    title: 'Apply a reflective coating to the flat roof',
    description:
      'Flat roofs absorb the most solar gain of any roof type. A reflective coating can drop surface temperature substantially and extend membrane life at the same time.',
    priority: 'Medium',
    estimatedCost: '$1–$3 per sq ft',
    weight: scores.heat + 5,
    propertySpecific: true,
  });

  pushIf(c, scores.heat >= 35 && scores.heat < 60, {
    id: 'heat-shading',
    hazard: 'heat',
    title: 'Shade west-facing glass before adding cooling capacity',
    description:
      'Exterior shades, awnings, or a planted tree line cut afternoon heat gain far more cheaply than upsizing an air conditioner.',
    priority: 'Low',
    estimatedCost: '$200–$2,500',
    weight: scores.heat,
  });

  // ── Storms ─────────────────────────────────────────────────────────────────
  pushIf(c, scores.storms >= 65 && profile.stories === '2plus', {
    id: 'storm-upper-openings',
    hazard: 'storms',
    title: 'Prioritise impact protection on upper-floor windows',
    description:
      'Wind speed rises with height, and upper-storey glass fails first. A single breach pressurises the structure and lifts the roof, so upper openings earn protection before ground-floor ones.',
    priority: 'High',
    estimatedCost: '$2,000–$10,000',
    weight: scores.storms + 8,
    propertySpecific: true,
  });

  pushIf(c, scores.storms >= 65, {
    id: 'storm-roof-connections',
    hazard: 'storms',
    title: 'Have roof-to-wall connections inspected and retrofitted',
    description:
      'Hurricane ties and properly nailed sheathing keep the roof attached under uplift. Losing the roof is what turns a repairable claim into a total loss.',
    priority: 'High',
    estimatedCost: '$1,000–$6,000',
    weight: scores.storms + 5,
  });

  pushIf(c, scores.storms >= 45, {
    id: 'storm-tree-work',
    hazard: 'storms',
    title: 'Remove overhanging limbs and any tree within striking distance',
    description:
      'Falling limbs cause more insured storm damage to houses than wind alone. Professional pruning ahead of the season is far cheaper than the claim.',
    priority: 'Medium',
    estimatedCost: '$400–$3,000',
    weight: scores.storms,
  });

  // ── Drought ────────────────────────────────────────────────────────────────
  pushIf(c, scores.drought >= 55 && profile.foundation === 'slab', {
    id: 'drought-slab-moisture',
    hazard: 'drought',
    title: 'Keep soil moisture even around the slab',
    description:
      'Expansive clay shrinks in drought and cracks slab foundations. Consistent perimeter watering during dry spells costs almost nothing and prevents structural repair that runs to five figures.',
    priority: 'High',
    estimatedCost: '$100–$1,500',
    weight: scores.drought + 12,
    propertySpecific: true,
  });

  pushIf(c, scores.drought >= 55, {
    id: 'drought-water-efficiency',
    hazard: 'drought',
    title: 'Convert to drought-tolerant landscaping and drip irrigation',
    description:
      'Restrictions in this area are likely to tighten. Xeriscaping cuts outdoor use sharply and many utilities rebate a meaningful share of the cost.',
    priority: 'Medium',
    estimatedCost: '$1,500–$10,000',
    weight: scores.drought + 2,
  });

  // ── Air quality ────────────────────────────────────────────────────────────
  pushIf(c, scores.airQuality >= 50, {
    id: 'air-filtration',
    hazard: 'airQuality',
    title: 'Fit MERV-13 filtration and seal the worst air leaks',
    description:
      'Wildfire smoke and particulate episodes are the practical driver here. MERV-13 in the HVAC return plus one portable HEPA unit makes a defensible clean-air room.',
    priority: scores.airQuality >= 70 ? 'High' : 'Medium',
    estimatedCost: '$150–$1,200',
    weight: scores.airQuality + 3,
  });

  // ── Baseline ───────────────────────────────────────────────────────────────
  const peak = Math.max(...(Object.values(scores) as number[]));

  pushIf(c, peak >= 30, {
    id: 'general-insurance-review',
    hazard: 'general',
    title: 'Review policy exclusions against the hazards above',
    description:
      'Flood, earth movement, and wind/hail deductibles are the usual gaps. Read the exclusions page specifically for the hazards this assessment flagged.',
    priority: 'Medium',
    estimatedCost: 'Free',
    weight: peak * 0.6,
  });

  pushIf(c, true, {
    id: 'general-documentation',
    hazard: 'general',
    title: 'Photograph the property and store records off-site',
    description:
      'Claims are settled on evidence. A room-by-room photo record in cloud storage costs nothing and materially changes what gets paid.',
    priority: 'Low',
    estimatedCost: 'Free',
    weight: 8,
  });

  c.sort((a, b) => b.weight - a.weight);

  const limit = peak >= 60 ? 6 : 5;
  return c.slice(0, limit).map(({ weight: _weight, ...rec }) => rec);
}

export function priorityRank(p: Priority): number {
  return p === 'High' ? 0 : p === 'Medium' ? 1 : 2;
}
