import assert from 'node:assert/strict';
import test from 'node:test';
import { prescriptionMedicines, prescriptionRows } from './prescriptionDraft.js';

const medicine = { name: 'Example', dosage: '5 mg', frequency: 'Once daily', duration_days: 7,
  timing: 'Before food', notes: 'Existing note' };

test('editing round-trips existing fields and preserves additional medicine details', () => {
  const original = { medicines: [{ ...medicine, custom_detail: 'preserve me' }] };
  const rows = prescriptionRows(original);
  rows[0].dosage = '10 mg';
  const updated = prescriptionMedicines(rows);
  assert.equal(updated[0].dosage, '10 mg');
  assert.equal(updated[0].timing, 'Before food');
  assert.equal(updated[0].notes, 'Existing note');
  assert.equal(updated[0].custom_detail, 'preserve me');
  assert.equal(original.medicines[0].dosage, '5 mg');
});

test('legacy day strings load into the editor without discarding duration', () => {
  const rows = prescriptionRows({ medicines: [{ ...medicine, duration_days: undefined, duration: '30 days', notes: null }] });
  assert.equal(prescriptionMedicines(rows)[0].duration_days, 30);
  assert.equal(rows[0].notes, '');
});

test('blank, fractional and out-of-range medicine durations cannot be saved', () => {
  for (const duration_days of ['', 0, -1, 366, 1.5, 'abc']) {
    assert.throws(() => prescriptionMedicines([{ ...medicine, duration_days }]));
  }
  assert.throws(() => prescriptionMedicines([]));
  assert.throws(() => prescriptionMedicines([{ ...medicine, dosage: '' }]));
});

test('removing a medicine preserves the remaining medicine details', () => {
  const rows = prescriptionRows({ medicines: [medicine, { ...medicine, name: 'Second medicine' }] });
  const updated = prescriptionMedicines(rows.slice(1));
  assert.equal(updated.length, 1);
  assert.equal(updated[0].name, 'Second medicine');
});
