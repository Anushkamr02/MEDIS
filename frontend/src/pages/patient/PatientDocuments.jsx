import { useOutletContext } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { ErrorState, Spinner } from '../../components/medis';
import MedicalDocumentsPanel from '../../components/MedicalDocumentsPanel';
import { CATEGORY_GROUPS } from '../../components/DocumentUpload';

/**
 * The patient's Medical Documents section: everything in their record,
 * from their own uploads and from their doctors, with view, download and
 * upload. A document can only be deleted by the account that uploaded
 * it, and the database decides that, not this page.
 */
export default function PatientDocuments() {
  const { user } = useAuth();
  const { documents, hospitals, loading, error, refresh } = useOutletContext();

  if (loading) return <Spinner text="Loading your documents..." />;

  return (
    <div className="content-enter space-y-5">
      {error && <ErrorState text={`Some data failed to load: ${error}`} onRetry={refresh} />}

      <div>
        <h1 className="text-2xl font-bold">Medical documents</h1>
        <p className="text-sm text-muted-foreground">
          Reports, scans and prescriptions kept with your record. PDFs and photos are both accepted, up to 20 MB.
        </p>
      </div>

      <MedicalDocumentsPanel
        patientId={user?.id}
        documents={documents}
        hospitals={hospitals}
        onChanged={refresh}
        title="All documents"
        maxHeight="min(70dvh, 48rem)"
      />

      <section className="rounded-xl border bg-card p-4 shadow-card sm:p-5">
        <h2 className="text-base font-semibold">Document types</h2>
        <p className="mt-1 text-sm text-muted-foreground">Filter the list above by any of these types.</p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {CATEGORY_GROUPS.map((group) => {
            const count = documents.filter((d) => group.categories.includes(d.category)).length;
            return (
              <li key={group.value} className="rounded-full border bg-muted/60 px-3 py-1 text-xs">
                {group.label} <span className="font-semibold">{count}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
