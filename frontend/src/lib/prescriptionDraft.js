export function prescriptionRows(prescription) {
  return (prescription.medicines ?? []).map((medicine) => ({
    ...medicine,
    name: medicine.name ?? '',
    dosage: medicine.dosage ?? '',
    frequency: medicine.frequency ?? '',
    // Older records stored only a display string such as "30 days".
    duration_days: medicine.duration_days ?? String(medicine.duration ?? '').match(/^(\d+)\s+days?$/i)?.[1] ?? '',
    timing: medicine.timing ?? '',
    notes: medicine.notes ?? '',
  }));
}

export function prescriptionMedicines(rows) {
  const filled = rows.filter((row) => row.name.trim());
  if (!filled.length) throw new Error('Add at least one medicine.');
  return filled.map((row) => {
    const days = Number(row.duration_days);
    if (!row.dosage.trim() || !row.frequency.trim() || !Number.isInteger(days) || days < 1 || days > 365) {
      throw new Error(`Fill in dosage, frequency and a duration of 1 to 365 days for ${row.name}.`);
    }
    return { ...row, name: row.name.trim(), dosage: row.dosage.trim(), frequency: row.frequency.trim(),
      duration: `${days} days`, duration_days: days, timing: row.timing, notes: row.notes.trim() || null };
  });
}
