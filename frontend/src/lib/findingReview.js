import { priorityInfo } from './aiPriority';
import { TREATMENT_STATUS, TREND } from './healthTrend';

// finding_reviews.outcome (migration v13).
export const REVIEW_OUTCOMES = {
  no_action: 'No action needed',
  follow_up_booked: 'Follow-up booked',
  patient_contacted: 'Patient contacted',
  treatment_changed: 'Treatment changed',
  escalated: 'Escalated / referred',
};

export const REVIEW_STATUS = {
  pending: 'Awaiting doctor review',
  reviewed: 'Reviewed',
};

// Fired after a review is saved, so every card showing that finding reloads.
export const REVIEWED_EVENT = 'medis:finding-reviewed';

// Default rule (IMPROVEMENT_PLAN §3.3, team question Q5): what makes a
// finding significant enough to need a recorded review.
export function assessmentFindings(a) {
  if (!a) return [];
  const priority = a.review_priority ?? a.report?.review_priority;
  const treatments = a.treatments ?? a.monitoring?.treatment_responses ?? [];
  return [
    (priority === 'URGENT_REVIEW' || priority === 'REVIEW') && `Review priority: ${priorityInfo(priority).label}`,
    a.health_trend === 'WORSENING' && `Trend: ${TREND.WORSENING.label}`,
    ...treatments
      .filter((t) => t.status === 'worsening_on_treatment')
      .map((t) => `${t.medicine}: ${TREATMENT_STATUS.worsening_on_treatment.label.toLowerCase()}`),
  ].filter(Boolean);
}

// Outside common adult reference ranges. Only intervals measured on a digital
// recording that passed its quality checks count; digitised printouts are for
// display only.
const ECG_INTERVAL_FLAGS = [
  ['pr_interval_ms', 'PR', (v) => v > 200 || v < 120],
  ['qrs_duration_ms', 'QRS', (v) => v >= 120],
  ['qtc_bazett_ms', 'QTc', (v) => v > 460],
];

export function ecgFindings(row) {
  if (row?.status !== 'validated_continuous_10s_analysis' || row.result?.validation?.overall_valid === false) return [];
  const intervals = row.result?.cardiac_intervals ?? {};
  return [
    row.classification?.prediction === 'MI' && 'ECG: possible myocardial infarction (MI)',
    ...ECG_INTERVAL_FLAGS.filter(([key, , outside]) => typeof intervals[key] === 'number' && outside(intervals[key])).map(
      ([key, label]) => `ECG: ${label} ${intervals[key]} ms outside the usual range`
    ),
  ].filter(Boolean);
}
