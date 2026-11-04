import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '../../lib/supabaseClient';
import { aiRequest } from '../../lib/aiClient';
import { openStoredDocument } from '../../lib/patientAccess';
import { formatDateTime } from '../../lib/format';
import { Button } from '../ui';
import { AIDisclaimer, EmptyState, ErrorState, Spinner } from '../medis';
import DigitalEcgUpload from './DigitalEcgUpload';
import DocumentAiActions from './DocumentAiActions';
import EcgResult from './EcgResult';

/** Reused on the patient dashboard and consultation; only queries accessible results. */
export default function EcgAnalysis({ patientId, consultationId, documents = [], compact = false }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rerunning, setRerunning] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data, error: fetchError } = await supabase.from('ecg_analyses').select('*')
        .eq('patient_id', patientId).order('created_at', { ascending: false }).limit(20);
      if (fetchError) throw fetchError;
      setRows(data ?? []);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [patientId]);
  useEffect(() => { load(); }, [load]);

  async function rerun(row) {
    setRerunning(true);
    const query = consultationId ? `?consultation_id=${consultationId}` : '';
    const { error: runError } = await aiRequest(`/ai/ecg/document/${row.document_id}${query}`);
    setRerunning(false);
    if (runError) toast.error(runError);
    else { toast.success('ECG analysis ready'); load(); }
  }

  const latest = rows[0];
  return (
    <div className="space-y-4">
      {error && <ErrorState text={error} onRetry={load} />}
      <div className="rounded-xl border bg-card p-4">
        <h3 className="mb-3 font-semibold">Digital ECG recording</h3>
        <DigitalEcgUpload patientId={patientId} consultationId={consultationId} onSaved={load} />
      </div>
      {!compact && <>
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Latest ECG analysis</h3><Button size="sm" variant="outline" disabled={loading} onClick={load}>Refresh results</Button></div>
          {loading ? <Spinner text="Loading ECG results…" /> : latest ? <>
            <EcgResult key={latest.id} status={latest.status} classification={latest.classification} result={latest.result} fileName={latest.file_name} createdAt={latest.created_at} />
            {latest.document_id ? <Button size="sm" variant="outline" disabled={rerunning} onClick={() => rerun(latest)}>{rerunning ? 'Analysing…' : 'Re-run analysis'}</Button>
              : <p className="text-xs text-muted-foreground">To re-run a digital analysis, select the original recording above.</p>}
          </> : !error && <EmptyState text="No ECG analysed yet. Choose a stored report below or upload a digital recording." />}
        </div>
        {documents.filter((d) => d.category === 'ecg').length > 0 && <div className="space-y-3 rounded-xl border bg-card p-4">
          <h3 className="font-semibold">Available ECG reports</h3>
          {documents.filter((d) => d.category === 'ecg').map((doc) => <div key={doc.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="break-all text-sm font-medium">{doc.file_name}</p>
              <Button size="sm" variant="outline" onClick={async () => { const { error: viewError } = await openStoredDocument(doc.file_url); if (viewError) toast.error(viewError); }}>View ECG</Button></div>
            <DocumentAiActions doc={doc} onAnalysed={load} />
          </div>)}
        </div>}
        {rows.length > 1 && <div className="space-y-3 rounded-xl border bg-card p-4">
          <h3 className="font-semibold">Recent ECG analyses</h3>
          {rows.slice(1).map((r) => <details key={r.id} className="rounded-lg border p-3"><summary className="cursor-pointer text-sm">{r.file_name || 'ECG recording'} · {formatDateTime(r.created_at)} · View details</summary><div className="mt-3"><EcgResult status={r.status} classification={r.classification} result={r.result} fileName={r.file_name} createdAt={r.created_at} /></div></details>)}
          <p className="text-xs text-muted-foreground">Showing the 20 most recent results at most.</p>
        </div>}
        <AIDisclaimer />
      </>}
    </div>
  );
}
