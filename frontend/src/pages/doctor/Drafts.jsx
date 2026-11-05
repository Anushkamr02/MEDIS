import { useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabaseClient';
import { formatDateTime } from '../../lib/format';
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, Button } from '../../components/ui';
import { EmptyState, ErrorState, IDChip, Section, Spinner } from '../../components/medis';

/**
 * This doctor's unfinished consultations (status 'pending'). Drafts are
 * private to the doctor who started them until finalized.
 */
export default function Drafts() {
  const { user } = useAuth();
  const { refreshDraftCount } = useOutletContext();
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deletingId, setDeletingId] = useState(null);
  const [selectedDraft, setSelectedDraft] = useState(null);
  const [deleteError, setDeleteError] = useState('');

  async function deleteDraft(draft) {
    if (deletingId) return;
    setDeletingId(draft.id);
    setDeleteError('');
    try {
      const { error: deleteError } = await supabase.rpc('delete_own_draft', { p_consultation_id: draft.id });
      if (deleteError) throw deleteError;
      setDrafts((previous) => previous.filter((d) => d.id !== draft.id));
      setSelectedDraft(null);
      refreshDraftCount();
      toast.success('Draft deleted');
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setDeletingId(null);
    }
  }

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
      <div>
        <h1 className="text-2xl font-bold">Drafts</h1>
        <p className="text-sm text-muted-foreground">Visits you started but haven't finalized. Only you can see these.</p>
      </div>
      {error && <ErrorState text={error} />}
      <Section title={`${drafts.length} unfinished`}>
        {loading ? (
          <Spinner text="Loading drafts..." />
        ) : drafts.length === 0 ? (
          <EmptyState text="No unfinished drafts." />
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
                {deletingId === d.id ? <Button size="sm" disabled>Resume</Button> : <Button size="sm" asChild>
                  <Link to={`/doctor/consultations/${d.id}`}>Resume</Link>
                </Button>}
                <Button size="sm" variant="destructive" aria-label="Delete draft" disabled={!!deletingId} onClick={() => { setDeleteError(''); setSelectedDraft(d); }}>
                  {deletingId === d.id ? 'Deleting...' : 'Delete'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <AlertDialog open={!!selectedDraft} onOpenChange={(open) => { if (!open && !deletingId) setSelectedDraft(null); }}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete draft?</AlertDialogTitle>
          <AlertDialogDescription>
            Delete {selectedDraft?.visit_id} for {selectedDraft?.profiles?.full_name ?? 'this patient'} and its draft prescriptions? This action cannot be undone.
          </AlertDialogDescription>
          {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
          <AlertDialogFooter>
            <Button variant="outline" disabled={!!deletingId} onClick={() => setSelectedDraft(null)}>Keep draft</Button>
            <Button variant="destructive" disabled={!!deletingId} onClick={() => deleteDraft(selectedDraft)}>
              {deletingId ? 'Deleting...' : 'Delete draft'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
