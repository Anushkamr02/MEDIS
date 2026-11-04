import { useOutletContext } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { ErrorState, Spinner } from '../../components/medis';
import PrescriptionsPanel from '../../components/PrescriptionsPanel';
import PrescriptionPdfButton from '../../components/ai/PrescriptionPdfButton';

/**
 * The patient's Prescriptions section: every prescription issued to them,
 * read-only. Writing a prescription belongs to a consultation, which only
 * a doctor can open, so nothing on this page can change the record.
 */
export default function PatientPrescriptions() {
  const { user } = useAuth();
  const { prescriptions, visits, loading, error, refresh } = useOutletContext();

  if (loading) return <Spinner text="Loading your prescriptions..." />;

  return (
    <div className="content-enter space-y-5">
      {error && <ErrorState text={`Some data failed to load: ${error}`} onRetry={refresh} />}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Prescriptions</h1>
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Lock className="h-3.5 w-3.5" aria-hidden />
            Every prescription your doctors have issued. This is a read-only copy of the issued document.
          </p>
        </div>
        <PrescriptionPdfButton path={`/pdf/history/${user?.id}`} label="Download my history (PDF)" size="default" busyLabel="Generating…" />
      </div>

      <PrescriptionsPanel prescriptions={prescriptions} visits={visits} title="All prescriptions" maxHeight="min(70dvh, 46rem)" />
    </div>
  );
}
