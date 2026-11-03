import { useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { aiRequest } from '../../lib/aiClient';
import { Button, Input } from '../ui';
import EcgResult from './EcgResult';

// Must match the AI service (server.py ECG_SUFFIXES and its filename rule)
const ACCEPT = '.hea,.dat,.mat,.csv,.npy';
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;
const MAX_BYTES = 25 * 1024 * 1024;

function checkFiles(files) {
  if (files.length === 0) return 'Choose the ECG file(s).';
  if (files.length > 16) return 'Choose at most 16 files.';
  const names = files.map((f) => f.name);
  const bad = names.find((n) => !SAFE_NAME.test(n) || n.startsWith('.'));
  if (bad) return `Rename "${bad}": use only letters, digits, dots, hyphens or underscores.`;
  if (files.some((f) => f.size === 0 || f.size > MAX_BYTES)) return 'Each file must be non-empty and at most 25 MB.';
  const lower = names.map((n) => n.toLowerCase());
  const headers = lower.filter((n) => n.endsWith('.hea'));
  for (const hea of headers) {
    const base = hea.slice(0, -4);
    if (!lower.includes(`${base}.dat`) && !lower.includes(`${base}.mat`)) {
      return `"${hea}" needs its signal file (${base}.dat or ${base}.mat) selected too.`;
    }
  }
  if (lower.some((n) => n.endsWith('.dat') || n.endsWith('.mat')) && headers.length === 0) {
    return 'WFDB recordings need the .hea header file selected together with the .dat/.mat file.';
  }
  return '';
}

/**
 * Upload of a digital 12-lead ECG recording (WFDB .hea + .dat/.mat, or a
 * 10-second CSV/NPY array) for the CNN. Image/PDF ECGs go through
 * "Analyse ECG" on the stored document instead.
 */
export default function DigitalEcgUpload({ patientId, consultationId, onSaved }) {
  const input = useRef(null);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ecg, setEcg] = useState(null);

  function choose(e) {
    const chosen = Array.from(e.target.files ?? []);
    setFiles(chosen);
    setEcg(null);
    setError(chosen.length ? checkFiles(chosen) : '');
  }

  async function upload() {
    const problem = checkFiles(files);
    if (problem) {
      setError(problem);
      return;
    }
    setError('');
    setBusy(true);
    const formData = new FormData();
    formData.append('patient_id', patientId);
    if (consultationId) formData.append('consultation_id', consultationId);
    files.forEach((f) => formData.append('files', f));
    const { data, error: uploadError } = await aiRequest('/ai/ecg/upload', { formData });
    setBusy(false);
    if (uploadError) {
      setError(uploadError);
      return;
    }
    setEcg(data);
    setFiles([]);
    if (input.current) input.current.value = '';
    onSaved?.(data.analysis);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input ref={input} type="file" multiple accept={ACCEPT} onChange={choose} disabled={busy} className="max-w-sm" aria-label="Digital ECG files" />
        <Button type="button" size="sm" variant="outline" className="border-ai/30 text-ai hover:bg-ai-soft" onClick={upload} disabled={busy || files.length === 0 || !!error}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {busy ? 'Analysing ECG...' : 'Upload & analyse (AI)'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        WFDB (.hea with its .dat or .mat), or a CSV/NPY file with 12 lead columns covering 10 seconds. The files are analysed, not stored; the
        result is saved to the patient's record.
      </p>
      {error && (
        <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {ecg && (
        <div className="rounded-lg border p-3">
          <EcgResult
            status={ecg.analysis.status}
            classification={ecg.analysis.classification}
            result={ecg.result}
            fileName={ecg.analysis.file_name}
            createdAt={ecg.analysis.created_at}
          />
        </div>
      )}
    </div>
  );
}
