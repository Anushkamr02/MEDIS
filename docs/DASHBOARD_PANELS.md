# Doctor and patient dashboard panels

This change fixes the overflowing containers in the doctor's patient record
and turns the patient dashboard into five navigable sections. It extends the
existing React/Vite app, Supabase schema and FastAPI service; it does not add
a second store and does not replace any existing screen.

## Required database migration

Apply `supabase/supabase_migration_v8.sql` after v7 using the project's
authorized Supabase migration workflow. **It has not been applied to the
connected database by this change, and the environment this was built in has
no Postgres instance, so it has not been executed anywhere.** Review it
before applying.

It adds:

| Object | Purpose |
|---|---|
| `log_patient_access(uuid, text, jsonb)` | The single entry point for recording an access event. Takes the actor from `auth.uid()`, lets `created_at` default to the server's `now()`, re-checks the caller's assignment to the patient, and rejects any action outside a fixed whitelist. |
| `get_patient_access_events(uuid, text, timestamptz, timestamptz, int, int)` | The individual audit events behind "Doctors who accessed my profile", newest first, with server-side search, date filtering and paging. Readable only by the patient themself or a doctor with an active assignment. |
| `get_patient_visits(uuid)` *(replaced)* | Same authorization and the same patient-visibility rules as v3f; extra columns for reason, specialization, follow-up date, doctor's notes and prescription/document counts. |
| `get_patient_visit_details(uuid)` | One visit in full, with its prescriptions and documents, as a single authorized jsonb payload. A patient gets nothing clinical from an unshared visit and cannot open a draft at all. |
| `delete_medical_report(uuid)` | Deletes a document, only for the account that uploaded it and only while it is not attached to a completed visit. Audits, then deletes, and returns the storage path. |
| storage policy `medical-reports: uploader deletes own object` | Lets an account remove only an object it uploaded. |
| `medical_reports.file_size_bytes` | Recorded by the upload form from now on. Older rows stay null and the UI says the size is unknown. |
| `idx_audit_logs_target_created` | Index for the access-history query. |

For databases through v7, dashboard reads now fall back only when PostgREST
reports a missing RPC (`PGRST202`). Access history uses the v3f
`get_patient_access_history` summary, explicitly labelled as one row per doctor.
Visit details use existing consultations, prescriptions and medical_reports
queries under the signed-in user's RLS policies. Unshared visits expose only
timeline metadata, and patients cannot open drafts. Permission and server errors
remain errors. V8 is still required for server-side access logging, document
deletion and uploads carrying `file_size_bytes`.

If the dashboard reports `Could not find the function
public.get_patient_access_events(...) in the schema cache`, run the full v8
migration in the Supabase SQL editor for the project configured by
`frontend/.env` (`VITE_SUPABASE_URL`). The frontend sends the six named
parameters defined by v8; an older function signature cannot serve this call.
The migration now requests a PostgREST schema-cache refresh on commit.
If v8 already completed successfully, refresh the cache directly:

```sql
NOTIFY pgrst, 'reload schema';
```

Then retry loading access history. A cache refresh alone does not create a
missing function. To check that the required signature exists, run:

```sql
SELECT to_regprocedure(
  'public.get_patient_access_events(uuid,text,timestamptz,timestamptz,integer,integer)'
);
```

A null result means the required function is absent; apply v8 after v7.

## Container scrolling

`ScrollPanel` in `frontend/src/components/medis.jsx` is the shared pattern:

- The panel is `flex min-h-0 min-w-0 flex-col overflow-hidden` with a
  per-panel `maxHeight` (no single universal height; responsive values such
  as `min(70dvh, 48rem)` are used on full-width pages).
- The header is `shrink-0`, so records never move it.
- The body is `flex-1 min-h-0 min-w-0` with the `.medis-scroll` class
  (`frontend/src/styles/theme.css`): `overflow-y: auto`, `overflow-x: hidden`,
  `overscroll-behavior: contain`, `-webkit-overflow-scrolling: touch`.
- `scrollbar-gutter: stable` keeps the track reserved and the thumb starts
  transparent, becoming visible on hover, `:focus-visible` and `:focus-within`.
  Only a colour changes, so revealing it causes no reflow. The same is done
  with `::-webkit-scrollbar-thumb` for engines that ignore `scrollbar-color`.
- The body has `tabIndex={0}` and an accessible label, so the list can be
  scrolled with the keyboard alone.
- Long file names, IDs and diagnoses wrap (`overflow-wrap: anywhere`) rather
  than widening the grid column.

Applied to: visit history (both dashboards), prescriptions, medical documents,
access history, health overview and recent activity. No fixed height is
imposed on any other page.

## What changed

**Doctor → My Patients → a patient** is now five sections, selected with
`?tab=overview|ecg|add-record|visits|prescriptions`, so links stay shareable.
Only the selected section mounts. Visit History uses the shared panel and the
shared "View details" modal.

**Patient dashboard** is five sections under `/patient`, `/patient/prescriptions`,
`/patient/documents`, `/patient/visits`, `/patient/access`. The record is
loaded once in `PatientLayout` and passed down through Outlet context, so
switching sections is a client-side route change with no refetch. Wide screens
get a row of links; below `md` the same five open in a drawer.

**Access history** is now one row per real recorded event, not one row per
doctor. The old per-doctor summary is kept below it, since it answers a
different question ("who holds access at all"). The frontend and the AI
service both record access through `log_patient_access`; neither inserts into
`audit_logs` directly any more, so no caller chooses its own timestamp. With
no recorded activity the panel shows an empty state — it never fabricates one.

### Main files

| File | Change |
|---|---|
| `supabase/supabase_migration_v8.sql` | New. All of the above. |
| `src/components/medis.jsx` | `ScrollPanel`, `DetailsDialog` (focus restored explicitly on close). |
| `src/styles/theme.css` | `.medis-scroll`, `content-enter`. |
| `src/components/VisitHistoryPanel.jsx`, `VisitDetails.jsx`, `VisitTimeline.jsx` | New/rewritten shared visit history with search, date and doctor filters, and the details modal. |
| `src/components/PrescriptionsPanel.jsx` | New. Search, date and doctor filters, details modal, PDF download. |
| `src/components/MedicalDocumentsPanel.jsx` | New. Search, type filter, view, download, upload, delete. |
| `src/components/AccessEventsPanel.jsx` | New. Per-event access history with server-side search, filtering and paging. |
| `src/components/DocumentUpload.jsx` | Category groups, 20 MB limit, `file_size_bytes`, logs through the RPC. |
| `src/lib/patientAccess.js` | `logPatientAccess`, `downloadStoredDocument`. |
| `src/pages/PatientLayout.jsx` | Section navigation, shared record loading. |
| `src/pages/PatientDashboard.jsx` | Rewritten as the Dashboard section. |
| `src/pages/patient/*.jsx` | New. The four other sections. |
| `src/pages/doctor/PatientProfile.jsx` | Five record sections. |
| `src/hooks/usePatientData.js` | Loads recent ECG analyses. |
| `src/hooks/useNotifications.js` | Adopted; reports failures instead of throwing. |
| `backend/server.py`, `backend/supa.py` | `Supa.rpc()`; `audit()` routes through `log_patient_access`. |

## Verification performed

From `frontend`:

```powershell
npm run build          # passes
npm run test:e2e       # tests/dashboards.spec.js: 50 passed, 1 skipped
```

`tests/dashboards.spec.js` runs at 1440 px, 820 px and 390 px with every
Supabase and AI call intercepted by synthetic fixtures. It covers the five
doctor sections and direct links; the visit panel staying inside its cap with
14 records and long text; the header holding still while the body scrolls by
wheel and by keyboard; neighbouring panels keeping their size; the details
modal's content, Escape and focus restoration; an unshared visit showing no
clinical detail to the patient; the five patient sections, the drawer and
switching without a reload; the quick actions; the identity card; prescription
filters and modal; document size, type filter and delete being offered only
for the account's own upload; a refused delete leaving the document in place;
the access history's real events, search, details, empty state and error
retry; and that opening a record logs through `log_patient_access` with no
direct `audit_logs` insert. Every test also asserts the page does not scroll
sideways.

From `backend`:

```powershell
python -m unittest test_longitudinal_engine test_visit_patterns test_record_summary test_access_audit
```

49 tests pass (43 pre-existing, 6 new in `test_access_audit.py`, which cover
the service-side audit path: whitelisted actions only, no caller-chosen actor
or timestamp, no direct `audit_logs` write, and a refused log not hiding the
clinical result).

### Not verified here

- **The migration has not been executed.** No Postgres or Docker daemon was
  available. The SQL was reviewed statically only.
- **RLS and the database-side authorization** therefore have no automated
  test. Browser fixtures verify client behaviour against a synthetic server;
  they prove nothing about the deployed policies.
- `tests/redesign.spec.js` (pre-existing, uncommitted) fails 12 of 16 on the
  desktop project. The same file fails 14 of 16 against a pristine checkout
  of `HEAD`, so this change fixes two and breaks none. The remaining failures
  describe an earlier redesign of login, My Patients, drafts and the trend
  charts that was never applied to this tree; one of them expects six record
  tabs where this change implements the five that were specified.

## Deployment acceptance checks

After applying v8, with disposable test accounts:

- A patient sees access events only for their own profile; calling
  `get_patient_access_events` with another patient's id is refused.
- A doctor without an active assignment is refused by
  `get_patient_visits`, `get_patient_visit_details` and `log_patient_access`.
- `log_patient_access` refuses an action outside its whitelist, and the
  recorded `created_at` is the server's, not the caller's.
- A patient sees no diagnosis, notes, symptoms or prescriptions for a visit
  that has not been shared, and cannot open another doctor's draft.
- `delete_medical_report` refuses a document the caller did not upload and one
  attached to a completed visit; the storage object of someone else's upload
  cannot be removed.
- A profile with no recorded access shows the empty state, with no rows.

## Known limitations

- The patient information card shows initials, not a photograph: the schema
  stores no profile picture, and none is invented.
- Filtering a doctor select back to "All" is done with the panel's
  "Clear filters" button, because a Radix select item cannot hold an empty
  value.
- Deleting a document removes the database row first and the stored file
  second. If the storage removal fails the UI says so; the record is already
  gone, which is the authoritative state.
- `src/components/AuthLayout.jsx` and `src/components/SecureDocumentPreview.jsx`
  were already in the tree, unreferenced, and are outside this change's scope.
  They remain unused.
- `README.md` still contains unresolved merge-conflict markers from an earlier
  commit. The migration list was updated inside the existing `HEAD` section;
  the conflict itself was left alone.
