import { toast } from 'sonner';
import { aiRequest } from './aiClient';
import { trendInfo } from './healthTrend';

/**
 * Re-checks a patient after a clinical event. The database (migration v12)
 * has already queued the patient, so a failure here loses nothing: the
 * queue is processed later from the doctor's dashboard.
 */
export async function runMonitoring(patientId, triggerEvent, triggerRef = null) {
  const { data, error } = await aiRequest(`/ai/monitor/${patientId}`, {
    body: { trigger_event: triggerEvent, trigger_ref: triggerRef },
  });
  if (error) {
    toast.message('Saved. Monitoring will update shortly.');
    return null;
  }
  const info = trendInfo(data.health_trend);
  const count = data.reasons?.length ?? 0;
  toast.success(`Monitoring updated: ${info.label} ${info.arrow}${count ? ` (${count} reason${count === 1 ? '' : 's'})` : ''}`);
  return data;
}
