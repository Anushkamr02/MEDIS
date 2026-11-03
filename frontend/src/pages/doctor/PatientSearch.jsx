import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, Search, UserX } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabaseClient';
import { openPatientRecord } from '../../lib/patientAccess';
import { Button, Input } from '../../components/ui';
import { BackButton, ErrorState, IDChip, Section } from '../../components/medis';

/**
 * Look a patient up by their permanent MEDIS ID. The search function
 * only returns name + ID (never the medical record), and logs the search
 * to audit_logs. Opening the record is what grants this doctor access:
 * it creates the doctor_patient_assignments row that every RLS policy
 * on the medical tables checks. ?q= (from the header's quick search)
 * runs the search straight away.
 */
export default function PatientSearch() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initial = searchParams.get('q') ?? '';

  const [query, setQuery] = useState(initial);
  const [results, setResults] = useState(null);
  const [searchedId, setSearchedId] = useState('');
  const [searching, setSearching] = useState(false);
  const [openingId, setOpeningId] = useState(null);
  const [error, setError] = useState('');

  const runSearch = useCallback(async (value) => {
    setError('');
    setResults(null);
    const id = value.trim().toUpperCase();
    if (!id) return;

    setSearching(true);
    const { data, error: rpcError } = await supabase.rpc('search_patient_by_display_id', { p_display_id: id });
    setSearching(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setSearchedId(id);
    setResults(data ?? []);
  }, []);

  useEffect(() => {
    if (initial) {
      setQuery(initial);
      runSearch(initial);
    }
  }, [initial, runSearch]);

  async function openRecord(patient) {
    setError('');
    setOpeningId(patient.patient_id);

    const { error: accessError } = await openPatientRecord(user.id, patient.patient_id, 'search', {
      display_id: patient.display_id,
    });

    if (accessError) {
      setError(accessError.message);
      setOpeningId(null);
      return;
    }

    navigate(`/doctor/patients/${patient.patient_id}`);
  }

  return (
    <div className="max-w-2xl space-y-5">
      <BackButton />
      <h1 className="text-2xl font-bold">Search patient</h1>
      <Section title="Patient ID">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            runSearch(query);
          }}
        >
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="MEDIS-P-2026-00125" className="font-mono" aria-label="Patient ID" autoFocus />
          <Button type="submit" disabled={searching || !query.trim()}>
            {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Search
          </Button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">Enter the full Patient ID. Searches are recorded in the audit log.</p>
      </Section>
      {error && <ErrorState text={error} />}
      {results !== null && results.length === 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
          <UserX className="h-5 w-5" />
          No patient with ID <span className="font-mono">{searchedId}</span>. Check the ID with the patient and try again.
        </div>
      )}
      {results?.map((p) => (
        <div key={p.patient_id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 shadow-card">
          <div>
            <p className="font-semibold">{p.full_name || 'Unnamed patient'}</p>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <IDChip id={p.display_id} />
            </div>
          </div>
          <Button onClick={() => openRecord(p)} disabled={openingId === p.patient_id}>
            {openingId === p.patient_id && <Loader2 className="h-4 w-4 animate-spin" />}
            Open record
          </Button>
          <p className="w-full text-xs text-muted-foreground">Opening the record grants access and is logged in the patient's access history.</p>
        </div>
      ))}
    </div>
  );
}
