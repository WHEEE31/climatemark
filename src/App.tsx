import { useRef, useState, type FormEvent } from 'react';

import { ApiError, assess } from './lib/api';
import { pickSample, type SampleProperty } from './lib/samples';
import {
  Actions,
  Composite,
  EvidenceLedger,
  Finding,
  Outlook,
  SourceLog,
} from './components/Report';
import type { AssessmentResult, PropertyProfile } from '../shared/types';

type Status = 'idle' | 'loading' | 'done' | 'error';

/**
 * Optional property attributes. The assessment runs without any of them, but
 * two houses at the same coordinates need different advice: a wood shake roof
 * in a wildfire zone is the highest-leverage fix there is, and no location-only
 * model can surface it.
 */
const PROPERTY_FIELDS = [
  {
    key: 'yearBuilt' as const,
    label: 'Year built',
    options: [
      ['unknown', 'Not sure'],
      ['pre1980', 'Before 1980'],
      ['1980to2000', '1980–2000'],
      ['post2000', 'After 2000'],
    ],
  },
  {
    key: 'roof' as const,
    label: 'Roof',
    options: [
      ['unknown', 'Not sure'],
      ['asphalt', 'Asphalt shingle'],
      ['metalOrTile', 'Metal or tile'],
      ['woodShake', 'Wood shake'],
      ['flat', 'Flat / low slope'],
    ],
  },
  {
    key: 'foundation' as const,
    label: 'Foundation',
    options: [
      ['unknown', 'Not sure'],
      ['slab', 'Slab'],
      ['crawlspace', 'Crawlspace'],
      ['basement', 'Basement'],
      ['raised', 'Raised / piers'],
    ],
  },
  {
    key: 'stories' as const,
    label: 'Stories',
    options: [
      ['unknown', 'Not sure'],
      ['1', 'One'],
      ['2plus', 'Two or more'],
    ],
  },
];

export default function App() {
  const [address, setAddress] = useState('');
  const [property, setProperty] = useState<PropertyProfile>({});
  const [showDetails, setShowDetails] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<AssessmentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState<SampleProperty | null>(null);

  // Guards against a slow response landing after a newer request started.
  const requestId = useRef(0);

  async function run(query: string, profile: PropertyProfile) {
    const id = ++requestId.current;
    setStatus('loading');
    setError(null);
    setResult(null);

    try {
      const data = await assess({ address: query, property: profile });
      if (id !== requestId.current) return;
      setResult(data);
      setStatus('done');
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setStatus('error');
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const query = address.trim();
    if (query.length < 4) return;
    setSample(null);
    void run(query, property);
  }

  /**
   * Demo mode: load a curated property with details already filled in.
   * Each sample lands on a different dominant hazard, so clicking repeatedly
   * shows the assessment responding to location rather than averaging.
   */
  function onDemo() {
    const next = pickSample(sample?.address);
    setSample(next);
    setAddress(next.address);
    setProperty(next.property);
    setShowDetails(true);
    void run(next.address, next.property);
  }

  function setField<K extends keyof PropertyProfile>(key: K, value: PropertyProfile[K]) {
    setProperty((prev) => ({ ...prev, [key]: value }));
  }

  const busy = status === 'loading';

  return (
    <>
      <header className="masthead">
        <div className="shell masthead__inner">
          <span className="wordmark">
            <span className="wordmark__glyph" aria-hidden="true" />
            ClimateMark
          </span>
          <span className="masthead__tag">Property climate risk · public data only</span>
        </div>
      </header>

      <main className="shell">
        <section className="hero">
          <h1 className="hero__title">What is the climate risk at this address?</h1>

          <form onSubmit={onSubmit}>
            <div className="searchbar">
              <input
                className="input"
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Street, city, country — or 41.27, -73.86"
                aria-label="Property address"
                autoComplete="street-address"
              />
              <button className="btn" type="submit" disabled={address.trim().length < 4 || busy}>
                {busy ? 'Assessing…' : 'Assess'}
              </button>
            </div>

            <div className="hero__actions">
              <button className="btn btn--ghost" type="button" onClick={onDemo} disabled={busy}>
                Try a sample property
              </button>
              <button
                className="btn btn--ghost"
                type="button"
                onClick={() => setShowDetails((v) => !v)}
                aria-expanded={showDetails}
              >
                {showDetails ? 'Hide property details' : 'Add property details'}
              </button>
              <p className="hint">
                {sample
                  ? `${sample.label} — ${sample.note}`
                  : 'Property details are optional and sharpen the recommendations.'}
              </p>
            </div>

            {showDetails && (
              <div className="details">
                <div className="details__grid">
                  {PROPERTY_FIELDS.map((field) => (
                    <label className="field" key={field.key}>
                      <span className="field__label">{field.label}</span>
                      <select
                        className="select"
                        value={(property[field.key] as string) ?? 'unknown'}
                        onChange={(e) =>
                          setField(field.key, e.target.value as PropertyProfile[typeof field.key])
                        }
                      >
                        {field.options.map(([value, label]) => (
                          <option value={value} key={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </form>
        </section>

        {busy && (
          <div className="panel status">
            <div className="status__line">Resolving address…</div>
            <div className="status__line">Querying hazard datasets…</div>
            <div className="status__line">
              Building the thirty-year baseline — this one takes a few seconds.
            </div>
          </div>
        )}

        {status === 'error' && error && (
          <div className="error">
            <div className="error__title">Assessment failed</div>
            <p className="error__body">{error}</p>
          </div>
        )}

        {status === 'done' && result && (
          <>
            <Finding hazard={result.dominantHazard} address={result.resolvedAddress} />
            <Composite result={result} />
            <EvidenceLedger hazards={result.hazards} />
            {result.outlook && <Outlook outlook={result.outlook} />}
            <Actions recommendations={result.recommendations} />
            <SourceLog sources={result.sources} />
          </>
        )}
      </main>

      <footer className="footer">
        <div className="shell">
          <p>
            ClimateMark estimates exposure from public datasets — FEMA, NOAA, USDA Forest
            Service, the US Drought Monitor, Copernicus, and Open-Meteo. Authoritative hazard
            layers are largely United States–only; outside that coverage scores fall back to
            regional modelling and are stamped accordingly.
          </p>
          <p>
            This is not a professional risk assessment, an insurance quote, or a substitute for a
            survey or inspection. Do not rely on it as the sole basis for a property transaction.
          </p>
        </div>
      </footer>
    </>
  );
}
