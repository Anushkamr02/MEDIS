import { useMemo, useState } from 'react';
import { Download, ExternalLink, FileText, Search, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../lib/supabaseClient';
import { downloadStoredDocument, logPatientAccess, openStoredDocument } from '../lib/patientAccess';
import { formatDate } from '../lib/format';
import { Button, Input, Label, SimpleSelect } from './ui';
import { EmptyState, ScrollPanel, StatusPill } from './medis';
import DocumentUpload, { CATEGORY_GROUPS, categoryLabel, formatFileSize, groupOf } from './DocumentUpload';

const REVIEW_PILL = {
  pending_review: 'pending review',
  reviewed: 'reviewed',
  verified: 'verified',
  requires_clarification: 'needs clarification',
};

/**
 * Medical documents for one patient: searchable, grouped by the
 * document types patients actually look for, with view, download,
 * upload and — only for a document this account uploaded itself —
 * delete.
 *
 * `canDelete` only decides whether the button is rendered. The decision
 * that matters is made in the database: delete_medical_report() (v8)
 * refuses anything the caller did not upload and anything attached to a
 * completed visit, and the storage policy lets an account remove only
 * its own object. Hiding the button is a convenience, not the control.
 */
export default function MedicalDocumentsPanel({
  patientId,
  documents,
  hospitals = [],
  doctorId,
  defaultHospitalId = '',
  onChanged,
  title = 'Medical documents',
  maxHeight = '34rem',
  className,
  renderExtra,
}) {
  const [term, setTerm] = useState('');
  const [group, setGroup] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  // A doctor's view is for the record of a patient they have access to;
  // the uploader is the account that may remove its own upload.
  const currentUserId = doctorId ?? patientId;

  const filtered = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return documents.filter((d) => {
      if (group && groupOf(d.category) !== group) return false;
      if (!needle) return true;
      const haystack = [d.file_name, categoryLabel(d.category), d.description, d.doctor_name_note, d.hospitals?.name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [documents, term, group]);

  const filtering = !!(term || group);

  async function view(doc) {
    const { error } = await openStoredDocument(doc.file_url);
    if (error) {
      toast.error(error);
      return;
    }
    if (doctorId) logPatientAccess(patientId, 'viewed_document', { file_name: doc.file_name, category: doc.category });
  }

  async function download(doc) {
    const { error } = await downloadStoredDocument(doc.file_url, doc.file_name);
    if (error) {
      toast.error(error);
      return;
    }
    if (doctorId) logPatientAccess(patientId, 'downloaded_document', { file_name: doc.file_name, category: doc.category });
  }

  async function remove(doc) {
    if (!window.confirm(`Delete "${doc.file_name}"? This cannot be undone.`)) return;
    setDeletingId(doc.id);

    // The row goes first: the database is the record of truth and it is
    // what enforces who may delete. The stored file is then removed as a
    // follow-up, and a failure there is reported rather than hidden.
    const { data: path, error } = await supabase.rpc('delete_medical_report', { p_report_id: doc.id });
    if (error) {
      setDeletingId(null);
      toast.error(error.message);
      return;
    }

    const { error: storageError } = await supabase.storage.from('medical-reports').remove([path ?? doc.file_url]);
    setDeletingId(null);
    if (storageError) toast.warning('Document removed from your records, but the stored file could not be deleted.');
    else toast.success('Document deleted');
    onChanged?.();
  }

  return (
    <ScrollPanel
      id="documents"
      title={title}
      icon={<FileText className="h-4 w-4 text-primary" aria-hidden />}
      maxHeight={maxHeight}
      className={className}
      label={`${title}, scrollable list of ${filtered.length} document${filtered.length === 1 ? '' : 's'}`}
      footer={`Showing ${filtered.length} of ${documents.length} document${documents.length === 1 ? '' : 's'}.`}
      action={
        <div className="flex flex-wrap gap-2">
          {filtering && (
            <Button size="sm" variant="ghost" onClick={() => { setTerm(''); setGroup(''); }}>
              <X className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
          <Button size="sm" variant={uploadOpen ? 'default' : 'outline'} onClick={() => setUploadOpen((o) => !o)} aria-expanded={uploadOpen}>
            <Upload className="h-3.5 w-3.5" />
            {uploadOpen ? 'Close upload' : 'Upload document'}
          </Button>
        </div>
      }
    >
      {uploadOpen && (
        <div className="mb-3">
          <DocumentUpload
            patientId={patientId}
            doctorId={doctorId}
            hospitals={hospitals}
            defaultHospitalId={defaultHospitalId}
            showList={false}
            onUploaded={() => {
              setUploadOpen(false);
              onChanged?.();
            }}
          />
        </div>
      )}

      <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_14rem]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            className="pl-8"
            placeholder="Search documents by name or type"
            aria-label="Search documents"
          />
        </div>
        <div className="space-y-1">
          <Label className="sr-only">Document type</Label>
          <SimpleSelect
            value={group}
            onChange={setGroup}
            placeholder="All document types"
            ariaLabel="Filter by document type"
            options={CATEGORY_GROUPS.map((g) => [g.value, g.label])}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          text={filtering ? 'No documents match this search.' : 'No medical documents yet. Upload a report to keep it with your record.'}
          action={filtering && <Button size="sm" variant="outline" onClick={() => { setTerm(''); setGroup(''); }}>Clear filters</Button>}
        />
      ) : (
        <ul className="space-y-2">
          {filtered.map((d) => {
            const mine = d.uploaded_by === currentUserId;
            const size = formatFileSize(d.file_size_bytes);
            return (
              <li key={d.id} className="min-w-0 rounded-lg border p-3">
                <div className="flex flex-wrap items-start gap-3">
                  <FileText className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium">{d.file_name}</p>
                    <p className="mt-0.5 break-words text-xs text-muted-foreground">
                      {categoryLabel(d.category) || 'Uncategorised'}
                      {' · uploaded '}
                      {formatDate(d.uploaded_at)}
                      {d.report_date && ` · report dated ${formatDate(d.report_date)}`}
                      {size ? ` · ${size}` : ' · size unknown'}
                    </p>
                    <p className="break-words text-xs text-muted-foreground">
                      {d.hospitals?.name && `${d.hospitals.name} · `}
                      {d.doctor_name_note ? `Dr. ${d.doctor_name_note}` : d.uploaded_by === d.patient_id ? 'Uploaded by patient' : 'Added by doctor'}
                      {d.description && ` · ${d.description}`}
                    </p>
                  </div>
                  {d.review_status && <StatusPill value={REVIEW_PILL[d.review_status] ?? d.review_status} />}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => view(d)}>
                    <ExternalLink className="h-3.5 w-3.5" />
                    View
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => download(d)}>
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </Button>
                  {mine && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={deletingId === d.id}
                      onClick={() => remove(d)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {deletingId === d.id ? 'Deleting…' : 'Delete'}
                    </Button>
                  )}
                </div>
                {renderExtra?.(d)}
              </li>
            );
          })}
        </ul>
      )}
    </ScrollPanel>
  );
}
