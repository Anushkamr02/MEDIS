import { priorityInfo } from './aiPriority';

// escalation_events (migration v15). Time limits live in SQL (medis_escalation_after).
export const ESCALATION_LEVEL = {
  0: 'Urgent: review needed',
  1: 'Overdue urgent review',
  2: 'Level 2 escalation',
};

// Same wording as the findings in lib/findingReview.js.
export const ESCALATION_REASON = {
  critical_priority: `Review priority: ${priorityInfo('URGENT_REVIEW').label}`,
  ecg_possible_mi: 'ECG: possible myocardial infarction (MI)',
};

/**
 * One entry per escalated finding that is overdue (level 1 or 2) and still
 * has no review, highest level and oldest finding first.
 */
export function overdueFindings(events, reviewed) {
  const byFinding = new Map();
  for (const e of events) {
    const id = e.assessment_id ?? e.ecg_analysis_id;
    const top = byFinding.get(id);
    if (!top || e.level > top.level) byFinding.set(id, e);
  }
  return [...byFinding.entries()]
    .filter(([id, e]) => e.level >= 1 && !reviewed.has(id))
    .map(([id, e]) => ({ ...e, key: id }))
    .sort((a, b) => b.level - a.level || a.finding_at.localeCompare(b.finding_at));
}
