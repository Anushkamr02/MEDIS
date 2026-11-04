import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMissingRpc, loadVisitDetails } from '../src/lib/dashboardCompatibility.js';

const visit = { consultation_id: 'visit-1', status: 'completed', doctor_name: 'Doctor', final_diagnosis: 'Must stay hidden' };
function clientFor(row, rpcError = { code: 'PGRST202' }) {
  const calls = [];
  const client = {
    calls,
    rpc: async () => ({ data: null, error: rpcError }),
    auth: { getUser: async () => ({ data: { user: { id: 'patient' } }, error: null }) },
    from(table) {
      calls.push(table);
      const result = { data: table === 'consultations' ? row : [], error: null };
      const query = { select() { return this; }, eq() { return this; }, maybeSingle: async () => result, order: async () => result };
      return query;
    },
  };
  return client;
}

test('only missing functions trigger compatibility queries', async () => {
  assert.equal(isMissingRpc({ code: '42501' }), false);
  const client = clientFor(null, { code: '42501', message: 'Denied' });
  assert.equal((await loadVisitDetails(client, visit)).error.code, '42501');
  assert.deepEqual(client.calls, []);
});

test('unshared or RLS-hidden visits expose metadata without clinical content', async () => {
  for (const row of [null, { patient_id: 'patient', is_shared_with_patient: false, final_diagnosis: 'Private' }]) {
    const client = clientFor(row);
    const { data, error } = await loadVisitDetails(client, visit);
    assert.equal(error, null);
    assert.equal(data.is_visible, false);
    assert.equal(data.final_diagnosis, undefined);
    assert.deepEqual(data.prescriptions, []);
    assert.equal(client.calls.includes('prescriptions'), false);
  }
});

test('shared visits and authorized doctor visits show RLS-returned details', async () => {
  for (const row of [
    { patient_id: 'patient', is_shared_with_patient: true, final_diagnosis: 'Shared' },
    { patient_id: 'another-patient', is_shared_with_patient: false, final_diagnosis: 'Doctor view' },
  ]) {
    const { data } = await loadVisitDetails(clientFor(row), visit);
    assert.equal(data.is_visible, true);
    assert.equal(data.final_diagnosis, row.final_diagnosis);
  }
});

test('patients cannot open draft visits through the fallback', async () => {
  const result = await loadVisitDetails(clientFor({ patient_id: 'patient' }), { ...visit, status: 'pending' });
  assert.equal(result.data, null);
  assert.ok(result.error);
});
