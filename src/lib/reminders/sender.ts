import { getSupabase } from "../supabase";
import { sendTemplate, type TemplateSendResult } from "../whatsapp";
import { getBookingForReminder } from "./booking-loader";
import { isMuted, muteGlobally } from "./optout";
import { buildComponents } from "./templates";
import type { BookingForReminder, ReminderJobRow } from "./types";

const BATCH_LIMIT = 100;
const ATTEMPTS_CAP = 3;

export interface SweeperDeps {
  loadBooking: (id: string) => Promise<BookingForReminder | null>;
  isMuted: (phone: string, clinicId: string) => Promise<boolean>;
  sendTemplate: typeof sendTemplate;
  markSent: (id: string) => Promise<void>;
  markFailed: (id: string, err: string) => Promise<void>;
  markCancelled: (id: string, reason: string) => Promise<void>;
  bumpAttempts: (id: string, err: string) => Promise<void>;
  muteGlobally: (phone: string) => Promise<void>;
}

export const realDeps: SweeperDeps = {
  loadBooking: getBookingForReminder,
  isMuted,
  sendTemplate,
  markSent: async (id) => {
    await getSupabase()
      .from("reminder_jobs")
      .update({ sent_at: new Date().toISOString() })
      .eq("id", id);
  },
  markFailed: async (id, err) => {
    await getSupabase()
      .from("reminder_jobs")
      .update({ failed_at: new Date().toISOString(), last_error: err })
      .eq("id", id);
  },
  markCancelled: async (id, reason) => {
    await getSupabase()
      .from("reminder_jobs")
      .update({ failed_at: new Date().toISOString(), last_error: `cancelled:${reason}` })
      .eq("id", id);
  },
  bumpAttempts: async (id, err) => {
    const sb = getSupabase();
    const { data } = await sb.from("reminder_jobs").select("attempts").eq("id", id).maybeSingle();
    const current = (data?.attempts as number) ?? 0;
    const next = current + 1;
    if (next >= ATTEMPTS_CAP) {
      await sb.from("reminder_jobs")
        .update({
          attempts: next,
          last_error: err,
          failed_at: new Date().toISOString(),
        })
        .eq("id", id);
    } else {
      await sb.from("reminder_jobs")
        .update({ attempts: next, last_error: err })
        .eq("id", id);
    }
  },
  muteGlobally: async (phone) => muteGlobally(phone, "auto_block"),
};

export async function processJob(
  job: ReminderJobRow,
  deps: SweeperDeps = realDeps,
): Promise<void> {
  const booking = await deps.loadBooking(job.booking_id);
  if (!booking) {
    await deps.markCancelled(job.id, "booking_not_found");
    return;
  }
  if (booking.status !== "confirmed") {
    await deps.markCancelled(job.id, "not_confirmed");
    return;
  }
  if (await deps.isMuted(job.phone, job.clinic_id)) {
    await deps.markCancelled(job.id, "muted");
    return;
  }

  const components = buildComponents({
    template_name: job.template_name,
    template_vars: job.template_vars,
    booking_id: job.booking_id,
    clinic_id: job.clinic_id,
  });

  const result: TemplateSendResult = await deps.sendTemplate({
    to: job.phone,
    name: job.template_name,
    lang: "en",
    components,
  });

  switch (result.kind) {
    case "ok":
      await deps.markSent(job.id);
      return;
    case "permanent_block":
      await deps.markFailed(job.id, result.detail ?? "permanent_block");
      await deps.muteGlobally(job.phone);
      return;
    case "permanent_template":
      await deps.markFailed(job.id, result.detail ?? "permanent_template");
      return;
    case "transient":
      await deps.bumpAttempts(job.id, result.detail ?? "transient");
      return;
  }
}

export async function sweepDueJobs(deps: SweeperDeps = realDeps): Promise<{ processed: number }> {
  const sb = getSupabase();
  const { data: due, error } = await sb
    .from("reminder_jobs")
    .select("*")
    .lte("send_at", new Date().toISOString())
    .is("sent_at", null)
    .is("failed_at", null)
    .lt("attempts", ATTEMPTS_CAP)
    .order("send_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    console.error("[REMINDER] sweep query failed:", error.message);
    return { processed: 0 };
  }

  for (const row of (due ?? []) as ReminderJobRow[]) {
    try {
      await processJob(row, deps);
    } catch (err) {
      console.error(`[REMINDER] processJob ${row.id} threw:`, err);
      await deps.bumpAttempts(row.id, `exception:${String(err)}`);
    }
  }

  return { processed: due?.length ?? 0 };
}
