// Doctor-facing names for the engine's review priority (one place, so the
// AI panel, Overview and My Patients use the same words). It is a screening
// result from trends across visits, not a probability or a diagnosis.
export const PRIORITY = {
  URGENT_REVIEW: { label: 'Critical', cls: 'urgent', rank: 0 },
  REVIEW: { label: 'Needs review', cls: 'review', rank: 1 },
  NO_FLAGGED_PROGRESSION: { label: 'No concern found', cls: 'ok', rank: 2 },
  INSUFFICIENT_DATA: { label: 'Not enough data', cls: 'none', rank: 3 },
};

export const NOT_CHECKED = { label: 'Not checked', cls: 'none', rank: 4 };

export function priorityInfo(value) {
  return value ? PRIORITY[value] ?? PRIORITY.INSUFFICIENT_DATA : NOT_CHECKED;
}
