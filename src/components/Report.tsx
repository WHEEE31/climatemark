import { useEffect, useState } from 'react';

import type {
  AssessmentResult,
  ClimateOutlook,
  Confidence,
  Hazard,
  Recommendation,
  SourceStatus,
} from '../../shared/types';
import { CONFIDENCE_BLURB, CONFIDENCE_LABEL } from '../../shared/types';

const RISK_VAR = ['--r0', '--r1', '--r2', '--r3', '--r4', '--r5'];

function riskColor(score: number): string {
  const band =
    score >= 85 ? 5 : score >= 70 ? 4 : score >= 50 ? 3 : score >= 30 ? 2 : score >= 15 ? 1 : 0;
  return `var(${RISK_VAR[band]})`;
}

/** Animate a value from 0 on mount so bars and dials sweep in rather than snap. */
function useSweep(target: number): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setValue(target));
    return () => cancelAnimationFrame(id);
  }, [target]);
  return value;
}

export function Stamp({ confidence }: { confidence: Confidence }) {
  return (
    <span className={`stamp stamp--${confidence}`} title={CONFIDENCE_BLURB[confidence]}>
      {CONFIDENCE_LABEL[confidence]}
    </span>
  );
}

function ScoreDial({ score }: { score: number }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const swept = useSweep(score);
  const color = riskColor(score);

  return (
    <svg className="dial" viewBox="0 0 120 120" role="img" aria-label={`Score ${score} of 100`}>
      <circle className="dial__track" cx="60" cy="60" r={radius} />
      <circle
        className="dial__value"
        cx="60"
        cy="60"
        r={radius}
        stroke={color}
        strokeDasharray={`${(circumference * swept) / 100} ${circumference}`}
        transform="rotate(-90 60 60)"
      />
      <text className="dial__num" x="60" y="60" dy="0.1em" style={{ color }} fill={color}>
        {score}
      </text>
      <text className="dial__of" x="60" y="60" dy="1.9em">
        OF 100
      </text>
    </svg>
  );
}

export function Finding({ hazard, address }: { hazard: Hazard; address: string }) {
  return (
    <section className="section reveal">
      <div className="eyebrow">
        <span>01 — Finding</span>
      </div>
      <div className="panel finding">
        <div>
          <p className="finding__addr">{address}</p>
          <h2 className="finding__name">{hazard.name}</h2>
          <div className="finding__meta">
            <span className="finding__rating" style={{ color: riskColor(hazard.score) }}>
              {hazard.rating}
            </span>
            <Stamp confidence={hazard.confidence} />
          </div>
          <p className="finding__body">{hazard.description}</p>
          <p className="finding__source">Source: {hazard.dataSource}</p>
        </div>
        <ScoreDial score={hazard.score} />
      </div>
    </section>
  );
}

export function Composite({ result }: { result: AssessmentResult }) {
  const pct = Math.round(result.dataQuality * 100);
  const swept = useSweep(pct);

  if (result.compositeScore === null) {
    return (
      <section className="section reveal">
        <div className="eyebrow">
          <span>02 — Combined score</span>
        </div>
        <div className="notice">
          <div className="notice__title">Withheld</div>
          <p className="notice__body">{result.compositeSuppressedReason}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="section reveal">
      <div className="eyebrow">
        <span>02 — Combined score</span>
      </div>
      <div className="panel composite">
        <div className="composite__value" style={{ color: riskColor(result.compositeScore) }}>
          {result.compositeScore}
          <span className="composite__scale"> / 100</span>
        </div>
        <div className="composite__label">
          {result.compositeRating} across {result.hazards.length} hazards
        </div>
        <div className="quality">
          <span className="quality__text">Evidence {pct}%</span>
          <div className="quality__track">
            <div className="quality__fill" style={{ width: `${swept}%` }} />
          </div>
        </div>
      </div>
    </section>
  );
}

function LedgerRow({ hazard }: { hazard: Hazard }) {
  const swept = useSweep(hazard.score);
  const color = riskColor(hazard.score);

  return (
    <tr>
      <td>
        <div className="ledger__name">{hazard.name}</div>
        <div className="ledger__desc">{hazard.description}</div>
      </td>
      <td className="ledger__num">
        <span className="ledger__score" style={{ color }}>
          {hazard.score}
        </span>
        <span className="ledger__rating">{hazard.rating}</span>
        <div className="ledger__bar">
          <div
            className="ledger__barfill"
            style={{ width: `${swept}%`, background: color }}
          />
        </div>
      </td>
      <td>
        <Stamp confidence={hazard.confidence} />
      </td>
      <td className="ledger__src">{hazard.dataSource}</td>
    </tr>
  );
}

/**
 * Evidence ledger — the signature element. Every row carries its own
 * confidence stamp and named source, so it is visible at a glance which parts
 * of the assessment are measurements and which are approximations.
 */
export function EvidenceLedger({ hazards }: { hazards: Hazard[] }) {
  return (
    <section className="section reveal">
      <div className="eyebrow">
        <span>03 — Evidence</span>
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table className="ledger">
          <thead>
            <tr>
              <th>Hazard</th>
              <th>Score</th>
              <th>Basis</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {hazards.map((h) => (
              <LedgerRow hazard={h} key={h.id} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Outlook({ outlook }: { outlook: ClimateOutlook }) {
  const metrics = [
    {
      label: 'Mean daily high',
      then: `${outlook.baselineMaxTempC} °C`,
      now: `${outlook.projectedMaxTempC} °C`,
    },
    {
      label: 'Days above 32 °C',
      then: `${outlook.baselineHotDays}`,
      now: `${outlook.projectedHotDays}`,
    },
    {
      label: 'Annual precipitation',
      then: `${outlook.baselinePrecipMm} mm`,
      now: `${outlook.projectedPrecipMm} mm`,
    },
  ];

  return (
    <section className="section reveal">
      <div className="eyebrow">
        <span>04 — Thirty-year outlook</span>
      </div>
      <div className="panel">
        <div className="outlook__grid">
          {metrics.map((m) => (
            <div className="metric" key={m.label}>
              <div className="metric__label">{m.label}</div>
              <div className="metric__row">
                <span className="metric__then">{m.then}</span>
                <span className="metric__arrow">→</span>
                <span className="metric__now">{m.now}</span>
              </div>
            </div>
          ))}
        </div>
        <p className="outlook__note">
          {outlook.note}{' '}
          <span style={{ color: 'var(--muted)' }}>
            Baseline {outlook.baselinePeriod} (ERA5 reanalysis) against {outlook.projectionPeriod}{' '}
            (CMIP6 multi-model mean).
          </span>
        </p>
      </div>
    </section>
  );
}

export function Actions({ recommendations }: { recommendations: Recommendation[] }) {
  return (
    <section className="section reveal">
      <div className="eyebrow">
        <span>05 — What to do, in order</span>
      </div>
      <div className="panel">
        {recommendations.map((r) => (
          <article className="action" key={r.id}>
            <div className="action__head">
              <h3 className="action__title">{r.title}</h3>
              <span className={`action__pri action__pri--${r.priority}`}>{r.priority}</span>
            </div>
            <p className="action__body">{r.description}</p>
            <div className="action__foot">
              <span>{r.estimatedCost}</span>
              {r.propertySpecific && (
                <span className="tag--property">From your property details</span>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/** Real source outcomes, in place of invented loading messages. */
export function SourceLog({ sources }: { sources: SourceStatus[] }) {
  return (
    <section className="section reveal">
      <div className="eyebrow">
        <span>06 — Data retrieved</span>
      </div>
      <div className="panel sources">
        {sources.map((s, i) => (
          <div className="sources__item" key={`${s.name}-${i}`}>
            <span className={`sources__mark sources__mark--${s.status === 'ok' ? 'ok' : 'fail'}`}>
              {s.status === 'ok' ? '✓' : '✕'}
            </span>
            <span style={{ flex: 1 }}>{s.name}</span>
            {s.detail && <span>{s.detail}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
