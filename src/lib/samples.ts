import type { PropertyProfile } from '../../shared/types';

export interface SampleProperty {
  label: string;
  address: string;
  property: PropertyProfile;
  /** Why this one is worth showing — used for the demo caption. */
  note: string;
}

/**
 * Demo set.
 *
 * Each entry is chosen to land on a *different* dominant hazard, so clicking
 * through them shows that the assessment genuinely responds to location rather
 * than returning a house-shaped average. Property details are filled in to
 * match plausible local construction, which is what makes the property-specific
 * recommendations fire — the wood shake roof in Paradise and the basement in
 * Cedar Rapids are the two that most clearly demonstrate it.
 *
 * These are public civic and commercial addresses, not private residences.
 */
export const SAMPLE_PROPERTIES: SampleProperty[] = [
  {
    label: 'Coastal Florida',
    address: '1300 Gulf Blvd, Clearwater Beach, FL 33767',
    property: { yearBuilt: 'pre1980', roof: 'asphalt', foundation: 'slab', stories: '2plus' },
    note: 'Barrier island — expect flood and storm exposure to dominate.',
  },
  {
    label: 'Wildfire country',
    address: '6280 Skyway, Paradise, CA 95969',
    property: { yearBuilt: 'pre1980', roof: 'woodShake', foundation: 'crawlspace', stories: '1' },
    note: 'Wood shake roof in a high wildfire zone — the single highest-leverage fix.',
  },
  {
    label: 'Desert heat',
    address: '200 W Washington St, Phoenix, AZ 85003',
    property: { yearBuilt: 'pre1980', roof: 'flat', foundation: 'slab', stories: '1' },
    note: 'Extreme heat plus drought, with a flat roof absorbing the load.',
  },
  {
    label: 'Tornado Alley',
    address: '200 N Walker Ave, Oklahoma City, OK 73102',
    property: { yearBuilt: '1980to2000', roof: 'asphalt', foundation: 'slab', stories: '2plus' },
    note: 'Severe convective storms are the defining risk here.',
  },
  {
    label: 'River floodplain',
    address: '101 First St SE, Cedar Rapids, IA 52401',
    property: { yearBuilt: 'pre1980', roof: 'asphalt', foundation: 'basement', stories: '2plus' },
    note: 'Basement in a floodplain — triggers utility elevation advice.',
  },
  {
    label: 'Pacific Northwest',
    address: '600 4th Ave, Seattle, WA 98104',
    property: { yearBuilt: 'post2000', roof: 'metalOrTile', foundation: 'basement', stories: '2plus' },
    note: 'A comparatively low-risk profile — useful contrast to the others.',
  },
  {
    label: 'Gulf Coast',
    address: '1300 Perdido St, New Orleans, LA 70112',
    property: { yearBuilt: 'pre1980', roof: 'asphalt', foundation: 'raised', stories: '2plus' },
    note: 'Raised construction in a hurricane and flood zone.',
  },
  {
    label: 'Outside US coverage',
    address: 'Piazza del Duomo, Milan, Italy',
    property: { yearBuilt: 'pre1980', roof: 'metalOrTile', foundation: 'basement', stories: '2plus' },
    note: 'Shows the confidence system downgrading, and the combined score being withheld.',
  },
];

/** Pick a sample at random, avoiding an immediate repeat. */
export function pickSample(previous?: string): SampleProperty {
  const pool =
    SAMPLE_PROPERTIES.length > 1 && previous
      ? SAMPLE_PROPERTIES.filter((s) => s.address !== previous)
      : SAMPLE_PROPERTIES;
  return pool[Math.floor(Math.random() * pool.length)];
}
