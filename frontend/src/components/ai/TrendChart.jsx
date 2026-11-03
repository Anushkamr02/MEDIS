import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatDate } from '../../lib/format';

// Engine metric keys (backend/medis/ai/trajectories.py) with display labels,
// the usual target range (shaded) and which direction is better.
export const METRIC_INFO = {
  systolic_bp: { label: 'Systolic BP', ref: [90, 130], target: '< 130' },
  diastolic_bp: { label: 'Diastolic BP', ref: [60, 80], target: '< 80' },
  ldl_cholesterol: { label: 'LDL', ref: [0, 100], target: '< 100' },
  hdl_cholesterol: { label: 'HDL', higherIsBetter: true, ref: [40, 90], target: '> 40' },
  total_cholesterol: { label: 'Total cholesterol', ref: [0, 200], target: '< 200' },
  triglycerides: { label: 'Triglycerides', ref: [0, 150], target: '< 150' },
  hba1c: { label: 'HbA1c', ref: [4, 5.7], target: '< 5.7' },
  fasting_glucose: { label: 'Fasting glucose', ref: [70, 100], target: '< 100' },
  bmi: { label: 'BMI', ref: [18.5, 25], target: '18.5–25' },
  serum_creatinine: { label: 'Creatinine', ref: [0.6, 1.2], target: '0.6–1.2' },
  egfr: { label: 'eGFR', higherIsBetter: true, ref: [90, 130], target: '> 90' },
};

const GROUPS = [
  { id: 'bp', label: 'Blood pressure', metrics: ['systolic_bp', 'diastolic_bp'] },
  { id: 'chol', label: 'Cholesterol', metrics: ['ldl_cholesterol', 'hdl_cholesterol', 'total_cholesterol', 'triglycerides'] },
  { id: 'sugar', label: 'Sugar', metrics: ['hba1c', 'fasting_glucose'], split: true },
  { id: 'body', label: 'Body', metrics: ['bmi'] },
  { id: 'kidney', label: 'Kidney', metrics: ['serum_creatinine', 'egfr'], split: true },
];

const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];

function signed(n, digits = 1) {
  const v = Math.round(n * 10 ** digits) / 10 ** digits;
  return `${v > 0 ? '+' : ''}${v}`;
}

function TrendHeader({ metricKey, series }) {
  const info = METRIC_INFO[metricKey];
  const label = info?.label ?? metricKey;
  if (!series?.count) return <p className="text-xs text-muted-foreground">No {label} recorded yet.</p>;
  const last = series.points.at(-1);
  if (series.delta === null || series.delta === undefined || series.direction === 'SHORT_INTERVAL') {
    return (
      <p className="text-xs text-muted-foreground">
        <b className="text-foreground">
          {label} {last.value} {series.unit}
        </b>{' '}
        on {formatDate(last.date)} · Need another reading to show a trend.{series.stale && ' · Last measured >12 months ago'}
      </p>
    );
  }
  const up = series.direction === 'INCREASING' ? 1 : series.direction === 'DECREASING' ? -1 : 0;
  const worse = up === 0 ? 0 : info?.higherIsBetter ? -up : up;
  const Icon = up > 0 ? ArrowUp : up < 0 ? ArrowDown : ArrowRight;
  const tone = worse > 0 ? 'text-destructive' : worse < 0 ? 'text-success' : 'text-muted-foreground';
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs">
      <b>{label}</b>
      <span className={cn('inline-flex items-center gap-0.5 font-semibold', tone)}>
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {signed(series.delta)} {series.unit}
        {series.percent_change !== null && series.percent_change !== undefined && ` / ${signed(series.percent_change, 0)}%`}
      </span>
      <span className="text-muted-foreground">
        · {worse > 0 ? 'worsening' : worse < 0 ? 'improving' : 'stable'} · {series.count} readings
        {info?.target && ` · target ${info.target}`}
        {series.stale && ' · Last measured >12 months ago'}
      </span>
    </p>
  );
}

function Chart({ trajectories, keys, height = 220, showHeaders = true }) {
  const all = keys.map((k) => ({ k, series: trajectories[k] }));
  const merged = new Map();
  all.forEach(({ k, series }) =>
    (series?.points ?? []).forEach((p) => {
      const t = new Date(p.date).getTime();
      const evidence = p.evidence?.[0] ?? {};
      const row = merged.get(t) ?? { t, date: p.date, visitId: evidence.visit_id, hospital: evidence.hospital };
      row[k] = p.value;
      merged.set(t, row);
    })
  );
  const data = [...merged.values()].sort((a, b) => a.t - b.t);
  const ref = METRIC_INFO[keys[0]]?.ref;
  const hasAny = all.some((x) => x.series?.count > 0);
  return (
    <div className="space-y-1">
      {showHeaders && all.map(({ k, series }) => <TrendHeader key={k} metricKey={k} series={series} />)}
      {hasAny && (
        <div style={{ height }} className="w-full">
          <ResponsiveContainer>
            <LineChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={['dataMin - 864000000', 'dataMax + 864000000']}
                tickFormatter={(t) => new Date(t).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}
                tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
              />
              <YAxis tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} domain={['auto', 'auto']} />
              {ref && <ReferenceArea y1={ref[0]} y2={ref[1]} fill="var(--success)" fillOpacity={0.08} ifOverflow="extendDomain" />}
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const r = payload[0].payload;
                  return (
                    <div className="rounded-lg border bg-popover p-2 text-xs shadow-pop">
                      <p className="font-semibold">{formatDate(r.date)}</p>
                      {payload.map((p) => (
                        <p key={String(p.dataKey)}>
                          {METRIC_INFO[p.dataKey]?.label ?? p.dataKey}:{' '}
                          <b>
                            {p.value} {trajectories[p.dataKey]?.unit}
                          </b>
                        </p>
                      ))}
                      {r.hospital && <p className="text-muted-foreground">{r.hospital}</p>}
                      {r.visitId && <p className="font-mono text-muted-foreground">{r.visitId}</p>}
                    </div>
                  );
                }}
              />
              {keys.map((k, i) => (
                <Line
                  key={k}
                  dataKey={k}
                  name={METRIC_INFO[k]?.label ?? k}
                  type="monotone"
                  connectNulls
                  stroke={COLORS[i]}
                  strokeWidth={2}
                  dot={{ r: 4, fill: 'var(--card)', strokeWidth: 2 }}
                  activeDot={{ r: 6 }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {keys.length > 1 && (
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {keys.map((k, i) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span className="h-2 w-3 rounded-sm" style={{ background: COLORS[i] }} />
              {METRIC_INFO[k]?.label ?? k}
            </span>
          ))}
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-3 rounded-sm bg-success/20" />
            Target range
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Trend charts grouped like the teammate's design (BP, cholesterol, sugar,
 * body, kidney), from the engine's metric_trajectories. Groups without any
 * reading are hidden.
 */
export function TrendCharts({ trajectories = {}, compact }) {
  const groups = GROUPS.filter((g) => g.metrics.some((k) => trajectories[k]?.count > 0));
  const [selected, setSelected] = useState(null);
  if (groups.length === 0) return <p className="text-sm text-muted-foreground">No measurements recorded yet.</p>;
  const group = groups.find((g) => g.id === selected) ?? groups[0];
  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Metric group" className="flex flex-wrap gap-1.5">
        {groups.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={group.id === x.id}
            onClick={() => setSelected(x.id)}
            className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', group.id === x.id ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted')}
          >
            {x.label}
          </button>
        ))}
      </div>
      {group.split ? (
        <div className="grid gap-4 md:grid-cols-2">
          {group.metrics.map((k) => (
            <Chart key={k} trajectories={trajectories} keys={[k]} height={compact ? 150 : 190} />
          ))}
        </div>
      ) : (
        <Chart trajectories={trajectories} keys={group.metrics} height={compact ? 170 : 240} />
      )}
    </div>
  );
}

/** One metric's chart without the clinical header (patient view). */
export function SingleTrendChart({ trajectories, metricKey, height = 200 }) {
  return <Chart trajectories={trajectories} keys={[metricKey]} height={height} showHeaders={false} />;
}
