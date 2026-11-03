import { useState } from 'react';
import { FileDown, Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { openAiPdf } from '../../lib/aiClient';
import { formatDate } from '../../lib/format';
import { Button } from '../ui';

/**
 * Opens a PDF from the AI service (teammate's ReportLab generators): the
 * prescription by default, or any other `path` such as the history PDF.
 */
export default function PrescriptionPdfButton({ prescriptionId, path, label = 'Download PDF', variant = 'outline', size = 'sm', busyLabel = 'Preparing PDF...' }) {
  const [busy, setBusy] = useState(false);

  async function open() {
    setBusy(true);
    const { error: pdfError } = await openAiPdf(path || `/pdf/prescription/${prescriptionId}`);
    setBusy(false);
    if (pdfError) toast.error(pdfError);
  }

  return (
    <Button type="button" variant={variant} size={size} onClick={open} disabled={busy}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
      {busy ? busyLabel : label}
    </Button>
  );
}

/** One issued prescription (rows from public.prescriptions). */
export function PrescriptionCard({ rx, visitId }) {
  return (
    <article id={`rx-${rx.id}`} className="scroll-mt-24 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="font-medium">{formatDate(rx.issued_at)}</span>
          {rx.profiles?.full_name && <> · Dr. {rx.profiles.full_name}</>}
          {visitId && (
            <>
              {' '}
              · <span className="font-mono text-xs">{visitId}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Lock className="h-3 w-3" />
            Issued
          </span>
          <PrescriptionPdfButton prescriptionId={rx.id} />
        </div>
      </div>
      <ul className="mt-2 space-y-1.5">
        {(rx.medicines || []).map((m, i) => (
          <li key={i} className="rounded-md bg-muted/60 px-2.5 py-1.5 text-sm">
            <span className="font-medium">
              {m.name} {m.dosage}
            </span>
            <span className="text-muted-foreground">
              {[m.frequency, m.duration, m.timing, m.notes].filter(Boolean).map((x) => ` · ${x}`)}
            </span>
          </li>
        ))}
      </ul>
      {rx.instructions && <p className="mt-2 text-xs text-muted-foreground">{rx.instructions}</p>}
    </article>
  );
}
