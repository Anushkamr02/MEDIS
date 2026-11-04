import { useOutletContext } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { ErrorState, Section, Spinner } from '../../components/medis';
import AccessEventsPanel from '../../components/AccessEventsPanel';
import AccessHistory from '../../components/AccessHistory';

/**
 * The patient's "Doctors Who Accessed Profile" section.
 *
 * The event list is the audit record: real events the server wrote when
 * a doctor opened this record. Below it, the per-doctor summary shows who
 * currently holds access at all. A patient can only ever reach their own
 * history — both RPCs check the caller before returning a row.
 */
export default function PatientAccess() {
  const { user } = useAuth();
  const { accessHistory, loading, error, refresh } = useOutletContext();

  if (loading) return <Spinner text="Loading your access history..." />;

  return (
    <div className="content-enter space-y-5">
      {error && <ErrorState text={`Some data failed to load: ${error}`} onRetry={refresh} />}

      <div>
        <h1 className="text-2xl font-bold">Doctors who accessed your profile</h1>
        <p className="text-sm text-muted-foreground">
          Each entry is an access the server recorded at the moment it happened. Nothing here is an example or a placeholder.
        </p>
      </div>

      <AccessEventsPanel
        patientId={user?.id}
        title="Access records"
        maxHeight="min(70dvh, 46rem)"
        intro="Every time a doctor opens your record, views one of your documents or runs an analysis on it, the server records the event with its own timestamp."
      />

      <Section title="Doctors with access to your record">
        <AccessHistory rows={accessHistory} currentUserId={user?.id} />
      </Section>
    </div>
  );
}
