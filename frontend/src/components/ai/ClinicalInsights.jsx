import { useEffect } from 'react';
import { Lock } from 'lucide-react';
import { logPatientAccess } from '../../lib/patientAccess';

// Switching tabs remounts the module; one audit row per patient per 10 minutes is enough.
const VIEW_LOG_INTERVAL_MS = 10 * 60 * 1000;
const lastLogged = new Map();

/**
 * Groups every AI surface (screening, monitoring, ECG) as doctor-only
 * (IMPROVEMENT_PLAN §3.1). Patients receive only what a doctor publishes.
 * Opening it is audited as "Clinical Insights viewed" (§3.5, migration v15),
 * which the patient sees in their access history.
 */
export default function ClinicalInsights({ patientId, children }) {
  useEffect(() => {
    if (!patientId || Date.now() - (lastLogged.get(patientId) ?? 0) < VIEW_LOG_INTERVAL_MS) return;
    lastLogged.set(patientId, Date.now());
    logPatientAccess(patientId, 'viewed_clinical_insights');
  }, [patientId]);

  return (
    <section aria-label="Clinical Insights" className="min-w-0 space-y-4 rounded-2xl border border-dashed border-ai/40 bg-ai-soft/40 p-3 sm:p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-ai">
        <Lock className="h-4 w-4" aria-hidden />
        Clinical Insights: doctor only, not visible to the patient
      </p>
      {children}
    </section>
  );
}
