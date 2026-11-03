import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabaseClient';
import { useAssignedPatients } from '../../hooks/useDoctorData';
import { formatDate, formatDateTime } from '../../lib/format';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Input,
  Label,
  SimpleSelect,
} from '../../components/ui';
import { BackButton, EmptyState, ErrorState, Section, SegmentedTabs, Spinner, StatusPill, pillValue } from '../../components/medis';
import { isAppointmentNow, isAppointmentOpen, openPatientRecord } from '../../lib/patientAccess';

const DURATIONS = [15, 30, 45, 60];

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function todayIso() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

/**
 * Book and manage this doctor's appointments. Can be opened with
 * ?patient=<uuid>&consultation=<uuid>&date=YYYY-MM-DD (from the
 * consultation page's "Book follow-up") to prefill the form.
 * Double-booking is blocked by the check_appointment_conflict trigger;
 * its error message is shown as-is.
 */
export default function DoctorAppointments() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { patients } = useAssignedPatients(user?.id);

  const consultationId = searchParams.get('consultation');

  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [tab, setTab] = useState('upcoming');
  const [updatingId, setUpdatingId] = useState(null);

  const [patientId, setPatientId] = useState(searchParams.get('patient') ?? '');
  const [date, setDate] = useState(searchParams.get('date') ?? '');
  const [time, setTime] = useState('10:00');
  const [duration, setDuration] = useState(30);
  const [reason, setReason] = useState(consultationId ? 'Follow-up consultation' : '');
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState('');
  const [cancelling, setCancelling] = useState(null); // appointment awaiting cancel confirmation

  const loadAppointments = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    setListError('');

    const { data, error } = await supabase
      .from('appointments')
      .select(
        'id, scheduled_at, duration_minutes, reason, status, booked_by, patient_id, related_consultation_id, ' +
          'profiles:patient_id(full_name, display_id), consultations:related_consultation_id(visit_id)'
      )
      .eq('doctor_id', user.id)
      .order('scheduled_at', { ascending: true });

    if (error) setListError(error.message);
    setAppointments(data ?? []);
    setLoading(false);
  }, [user?.id]);

  useEffect(() => {
    loadAppointments();
  }, [loadAppointments]);

  async function handleBook(e) {
    e.preventDefault();
    setBookError('');

    const scheduledAt = new Date(`${date}T${time}`);
    if (Number.isNaN(scheduledAt.getTime())) {
      setBookError('Pick a valid date and time.');
      return;
    }
    if (scheduledAt <= new Date()) {
      setBookError('Pick a time in the future.');
      return;
    }

    setBooking(true);
    const { error } = await supabase.from('appointments').insert({
      patient_id: patientId,
      doctor_id: user.id,
      scheduled_at: scheduledAt.toISOString(),
      duration_minutes: Number(duration),
      reason: reason.trim() || null,
      status: 'scheduled',
      booked_by: 'doctor',
      related_consultation_id: consultationId || null,
    });
    setBooking(false);

    if (error) {
      // 42501 = RLS rejected the insert (no active assignment to this patient)
      setBookError(error.code === '42501' ? "You don't have access to this patient." : error.message);
      return;
    }

    const patientName = patients.find((p) => p.patient_id === patientId)?.profiles?.full_name;
    toast.success(`Booked ${patientName ?? 'patient'} for ${formatDateTime(scheduledAt.toISOString())}`);
    setDate('');
    setReason('');
    setTab('upcoming');
    loadAppointments();
  }

  // Grants access if the patient booked directly (no assignment yet),
  // then opens their record with this appointment as context.
  async function openAppointment(appointment) {
    setListError('');
    setUpdatingId(appointment.id);
    const { error } = await openPatientRecord(user.id, appointment.patient_id, 'appointment', {
      appointment_id: appointment.id,
    });
    setUpdatingId(null);
    if (error) {
      setListError(error.message);
      return;
    }
    navigate(`/doctor/patients/${appointment.patient_id}`, {
      state: {
        appointment: {
          id: appointment.id,
          scheduled_at: appointment.scheduled_at,
          reason: appointment.reason,
        },
      },
    });
  }

  async function updateStatus(appointment, status) {
    setListError('');
    setUpdatingId(appointment.id);
    const { error } = await supabase
      .from('appointments')
      .update({ status })
      .eq('id', appointment.id);
    setUpdatingId(null);

    if (error) {
      setListError(error.message);
      return;
    }
    loadAppointments();
  }

  // An appointment in progress (or that ended under 30 minutes ago) still
  // counts as upcoming, so the doctor can open it during the slot.
  const now = new Date();
  const upcoming = appointments.filter((a) => isAppointmentOpen(a, now));
  const past = appointments.filter((a) => !isAppointmentOpen(a, now)).reverse();
  const visible = tab === 'upcoming' ? upcoming : past;

  return (
    <div className="space-y-5">
      <BackButton />
      <h1 className="text-2xl font-bold">Appointments</h1>
      <Section title="Book appointment">
        {consultationId && <p className="mb-3 text-xs text-muted-foreground">This appointment will be linked to the consultation you came from.</p>}
        <form onSubmit={handleBook} className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1 sm:col-span-2">
            <Label>Patient</Label>
            <SimpleSelect
              value={patientId}
              onChange={setPatientId}
              placeholder="Choose from your patients"
              options={patients.map((p) => [p.patient_id, `${p.profiles?.full_name || 'Unnamed'} · ${p.profiles?.display_id ?? '—'}`])}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="appt-date">Date</Label>
            <Input id="appt-date" type="date" min={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} required />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="appt-time">Time</Label>
              <Input id="appt-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
            </div>
            <div className="space-y-1">
              <Label>Duration</Label>
              <SimpleSelect value={String(duration)} onChange={(v) => setDuration(Number(v))} options={DURATIONS.map((d) => [String(d), `${d} min`])} />
            </div>
          </div>
          <div className="space-y-1 sm:col-span-4">
            <Label htmlFor="appt-reason">Reason</Label>
            <Input id="appt-reason" placeholder="e.g. Review lipid profile results" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {bookError && (
            <p role="alert" className="text-sm text-destructive sm:col-span-4">
              {bookError}
            </p>
          )}
          <div>
            <Button type="submit" disabled={booking || !patientId}>
              {booking && <Loader2 className="h-4 w-4 animate-spin" />}
              Book appointment
            </Button>
          </div>
        </form>
      </Section>

      <SegmentedTabs
        label="Appointment list"
        value={tab}
        onChange={setTab}
        options={[
          ['upcoming', `Upcoming (${upcoming.length})`],
          ['past', `Past & closed (${past.length})`],
        ]}
      />
      {listError && <ErrorState text={listError} />}
      <Section title={tab === 'upcoming' ? 'Upcoming' : 'Past & closed'}>
        {loading ? (
          <Spinner text="Loading appointments..." />
        ) : visible.length === 0 ? (
          <EmptyState text={tab === 'upcoming' ? 'No upcoming appointments.' : 'No past appointments.'} />
        ) : (
          <ul className="divide-y">
            {visible.map((a) => {
              const isFuture = new Date(a.scheduled_at) >= now;
              const isNow = a.status === 'scheduled' && isAppointmentNow(a, now);
              const busy = updatingId === a.id;
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="w-28 text-sm">
                    <p className="font-semibold">{timeOf(a.scheduled_at)}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(a.scheduled_at)} · {a.duration_minutes}m
                    </p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {a.profiles?.full_name ?? 'Patient'}{' '}
                      {isNow && <span className="ml-1 rounded-full bg-destructive px-2 py-0.5 text-[10px] font-bold text-destructive-foreground">NOW</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {a.profiles?.display_id}
                      {a.reason && ` · ${a.reason}`}
                      {a.consultations?.visit_id && ` · from ${a.consultations.visit_id}`} · booked by {a.booked_by}
                    </p>
                  </div>
                  <StatusPill value={pillValue(a.status)} />
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant={isNow ? 'default' : 'outline'} disabled={busy} onClick={() => openAppointment(a)}>
                      Open
                    </Button>
                    {a.status === 'scheduled' && (
                      <>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => updateStatus(a, 'completed')}>
                          Done
                        </Button>
                        {isFuture ? (
                          <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => setCancelling(a)}>
                            Cancel
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => updateStatus(a, 'missed')}>
                            Missed
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <AlertDialog open={!!cancelling} onOpenChange={(open) => !open && setCancelling(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this appointment?</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelling && `${cancelling.profiles?.full_name ?? 'Patient'} · ${formatDateTime(cancelling.scheduled_at)}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                updateStatus(cancelling, 'cancelled');
                setCancelling(null);
              }}
            >
              Cancel appointment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
