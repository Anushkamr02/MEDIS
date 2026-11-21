// One place for the words both portals use for a doctor's access to a
// patient record (migration v11). The patient grants it; 'pending' is a
// request waiting for them.
export const ACCESS_STATUS = {
  none: { label: 'No access', cls: 'none' },
  pending: { label: 'Pending approval', cls: 'pending' },
  active: { label: 'Access granted', cls: 'ok' },
  denied: { label: 'Declined', cls: 'denied' },
  revoked: { label: 'Revoked', cls: 'none' },
};

export function accessStatusInfo(value, isActive) {
  if (value && ACCESS_STATUS[value]) return ACCESS_STATUS[value];
  // Rows from a database without v11 only carry is_active.
  if (isActive === true) return ACCESS_STATUS.active;
  if (isActive === false) return ACCESS_STATUS.revoked;
  return ACCESS_STATUS.none;
}
