import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabaseClient';
import { formatDateTime } from '../../lib/format';
import { Button } from '../../components/ui';
import { BackButton, EmptyState, ErrorState, IDChip, Section, Spinner } from '../../components/medis';

/**
 * This doctor's unfinished consultations (status 'pending'). Drafts are
 * private to the doctor who started them until finalized.
 */
export default function Drafts() {
  const { user } = useAuth();
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user?.id) return;

    supabase
      .from('consultations')
      .select('id, visit_id, consultation_date, patient_id, complaints, final_diagnosis, profiles:patient_id(full_name, display_id)')
      .eq('doctor_id', user.id)
      .eq('status', 'pending')
      .order('consultation_date', { ascending: false })
      .then(({ data, error: fetchError }) => {
        if (fetchError) setError(fetchError.message);
        setDrafts(data ?? []);
        setLoading(false);
      });
  }, [user?.id]);

  return (
    <div className="space-y-5">
      <BackButton />
      <div>
        <h1 className="text-2xl font-bold">Drafts</h1>
        <p className="text-sm text-muted-foreground">Visits you started but haven't finalized. Only you can see these.</p>
      </div>
      {error && <ErrorState text={error} />}
      <Section title={`${drafts.length} unfinished`}>
        {loading ? (
          <Spinner text="Loading drafts..." />
        ) : drafts.length === 0 ? (
          <EmptyState text="No drafts. Every consultation is finalized." />
        ) : (
          <ul className="divide-y">
            {drafts.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{d.profiles?.full_name ?? 'Patient'}</p>
                  <p className="text-xs text-muted-foreground">
                    Started {formatDateTime(d.consultation_date)}
                    {d.complaints?.main_complaint && ` · ${d.complaints.main_complaint}`}
                  </p>
                </div>
                <IDChip id={d.visit_id} />
                <Button size="sm" asChild>
                  <Link to={`/doctor/consultations/${d.id}`}>Resume</Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
