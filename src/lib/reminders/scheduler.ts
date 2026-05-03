import { getSupabase } from "../supabase";
import { getBookingForReminder } from "./booking-loader";
import { isMuted } from "./optout";
import { pickTemplateName, buildTemplateVars } from "./templates";
import type { BookingForReminder, ReminderKind } from "./types";

const BUFFER_MS = 5 * 60 * 1000;
const HOUR_MS = 3600 * 1000;

interface ComputedJob {
  booking_id: string;
  user_id: string;
  clinic_id: string;
  phone: string;
  kind: ReminderKind;
  template_name: string;
  template_vars: Record<string, string>;
  send_at: Date;
}

/**
 * Pure scheduling math. No DB writes, no opt-out check.
 * Returns 0..2 jobs (appt_24h, appt_2h) given a confirmed booking.
 * doc_ready jobs are enqueued separately via enqueueDocReady.
 */
export function computeReminderJobs(booking: BookingForReminder): ComputedJob[] {
  if (booking.status !== "confirmed") return [];

  const apptAt = booking.appointment_at;
  const now = Date.now();
  const out: ComputedJob[] = [];

  for (const [kind, offsetH] of [["appt_24h", 24], ["appt_2h", 2]] as const) {
    const sendAt = new Date(apptAt.getTime() - offsetH * HOUR_MS);
    if (sendAt.getTime() <= now + BUFFER_MS) continue;
    const template_name = pickTemplateName(kind, booking);
    const template_vars = buildTemplateVars(kind, booking);
    out.push({
      booking_id: booking.id,
      user_id: booking.user_id,
      clinic_id: booking.clinic_id,
      phone: booking.phone,
      kind,
      template_name,
      template_vars,
      send_at: sendAt,
    });
  }
  return out;
}

/**
 * Recompute reminders for a booking after any state change.
 * Deletes all unsent rows for the booking and re-inserts current intent.
 * No-ops if booking missing, not confirmed, or muted.
 */
export async function recomputeReminders(bookingId: string): Promise<void> {
  const sb = getSupabase();
  // 1. Delete pending rows (recompute model — see spec).
  await sb
    .from("reminder_jobs")
    .delete()
    .eq("booking_id", bookingId)
    .is("sent_at", null);

  const booking = await getBookingForReminder(bookingId);
  if (!booking) return;
  if (await isMuted(booking.phone, booking.clinic_id)) return;

  const jobs = computeReminderJobs(booking);
  if (jobs.length === 0) return;

  await sb.from("reminder_jobs").insert(
    jobs.map((j) => ({
      booking_id: j.booking_id,
      user_id: j.user_id,
      clinic_id: j.clinic_id,
      phone: j.phone,
      kind: j.kind,
      template_name: j.template_name,
      template_vars: j.template_vars,
      send_at: j.send_at.toISOString(),
    })),
  );
}

/**
 * Enqueue a doc_ready reminder. Idempotent — relies on
 * reminder_jobs_pending_unique to prevent double-insert.
 * Caller passes the doc type label that ends up in the template.
 */
export async function enqueueDocReady(args: {
  bookingId: string;
  docType: string;
}): Promise<void> {
  const sb = getSupabase();
  const booking = await getBookingForReminder(args.bookingId);
  if (!booking) return;
  if (await isMuted(booking.phone, booking.clinic_id)) return;

  const template_name = "doc_ready";
  const template_vars = buildTemplateVars("doc_ready", booking, { doc_type: args.docType });

  await sb.from("reminder_jobs").upsert(
    {
      booking_id: booking.id,
      user_id: booking.user_id,
      clinic_id: booking.clinic_id,
      phone: booking.phone,
      kind: "doc_ready",
      template_name,
      template_vars,
      send_at: new Date().toISOString(), // fire next sweep
    },
    { onConflict: "booking_id,kind" },
  );
}
