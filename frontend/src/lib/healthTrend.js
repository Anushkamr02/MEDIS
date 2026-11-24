// Doctor-facing names for the monitoring trend (backend medis/ai/monitoring.py).
// It says whether recorded values moved toward or away from target since the
// last check. It sits beside the review priority and is never merged with it.
export const TREND = {
  WORSENING: { label: 'Worsening', cls: 'worse', arrow: '↓', filter: 'worsening' },
  STABLE: { label: 'Stable', cls: 'stable', arrow: '→', filter: 'stable' },
  IMPROVING: { label: 'Improving', cls: 'better', arrow: '↑', filter: 'improving' },
  INSUFFICIENT_DATA: { label: 'Not enough data', cls: 'none', arrow: '—', filter: 'insufficient' },
};

export const NO_TREND = { label: 'Not monitored', cls: 'none', arrow: '—', filter: null };

export function trendInfo(value) {
  return value ? TREND[value] ?? TREND.INSUFFICIENT_DATA : NO_TREND;
}

// ?trend= values in My Patients (links from the Overview tiles).
export const TREND_FILTERS = {
  all: { label: 'All trends', matches: () => true },
  ...Object.fromEntries(Object.entries(TREND).map(([value, info]) => [info.filter, { label: info.label, matches: (t) => t === value }])),
};

// What started a monitoring run (cad_assessments.trigger_event).
export const TRIGGER_LABEL = {
  visit_finalized: 'Visit finalized',
  prescription_issued: 'Prescription issued',
  report_verified: 'Report verified',
  queued_recheck: 'Scheduled re-check',
  manual: 'Manual analysis',
};

export const METRIC_STATUS = {
  improving: { label: 'Improving', cls: 'better' },
  worsening: { label: 'Worsening', cls: 'worse' },
  stable: { label: 'Stable', cls: 'stable' },
  controlled: { label: 'At target', cls: 'better' },
  insufficient: { label: 'Not enough data', cls: 'none' },
};

export const TREATMENT_STATUS = {
  responding: { label: 'Responding', cls: 'better' },
  no_clear_response: { label: 'No clear response', cls: 'stable' },
  worsening_on_treatment: { label: 'Worsening on treatment', cls: 'worse' },
  awaiting_follow_up: { label: 'Awaiting follow-up', cls: 'none' },
  no_baseline: { label: 'No baseline reading', cls: 'none' },
};
