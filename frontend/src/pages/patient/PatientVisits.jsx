import { useOutletContext } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { ErrorState, Spinner } from '../../components/medis';
import VisitHistoryPanel from '../../components/VisitHistoryPanel';

/**
 * The patient's Visit History section. It uses the same panel and the
 * same get_patient_visits() rows as the doctor's record view, so both
 * sides show one consistent history — with the patient seeing clinical
 * detail only for the visits a doctor has shared.
 */
export default function PatientVisits() {
  const { user } = useAuth();
  const { visits, loading, error, refresh } = useOutletContext();

  if (loading) return <Spinner text="Loading your visit history..." />;

  return (
    <div className="content-enter space-y-5">
      {error && <ErrorState text={`Some data failed to load: ${error}`} onRetry={refresh} />}

      <div>
        <h1 className="text-2xl font-bold">Visit history</h1>
        <p className="text-sm text-muted-foreground">Every visit across every hospital, newest first. Open one for its full record.</p>
      </div>

      <VisitHistoryPanel
        visits={visits}
        viewer="patient"
        currentUserId={user?.id}
        title="All visits"
        maxHeight="min(70dvh, 48rem)"
      />
    </div>
  );
}
