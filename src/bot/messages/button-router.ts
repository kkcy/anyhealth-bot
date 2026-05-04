import { muteClinic, unmuteClinic } from "@/lib/reminders/optout";
import { getSupabase } from "@/lib/supabase";
import type { ThreadState } from "@/types";

export type ButtonAction =
  | { kind: "mute_clinic"; clinicId: string }
  | { kind: "unmute_clinic"; clinicId: string }
  | { kind: "view_booking"; bookingId: string }
  | { kind: "get_doc"; bookingId: string };

const PAYLOAD_RE = /^(mute_clinic|unmute_clinic|view_booking|get_doc):([a-zA-Z0-9_-]+)$/;

export function parseButtonPayload(text: string): ButtonAction | null {
  if (!text) return null;
  const m = text.match(PAYLOAD_RE);
  if (!m) return null;
  const [, kind, id] = m;
  switch (kind) {
    case "mute_clinic":   return { kind: "mute_clinic", clinicId: id };
    case "unmute_clinic": return { kind: "unmute_clinic", clinicId: id };
    case "view_booking":  return { kind: "view_booking", bookingId: id };
    case "get_doc":       return { kind: "get_doc", bookingId: id };
    default: return null;
  }
}

export interface HandleResult {
  /** When true, skip the AI tool loop entirely. */
  handled: boolean;
  /** Optional system-note to prepend to the AI loop on handled=false. */
  hint?: string;
}

export async function handleButtonAction(
  action: ButtonAction,
  ctx: {
    phone: string;
    thread: ThreadState;
    updateThread: (patch: Partial<ThreadState>) => Promise<void>;
    replyText: (text: string) => Promise<void>;
  },
): Promise<HandleResult> {
  // Auto-lookup user if state is fresh/stale
  if (!ctx.thread.userId) {
    const sb = getSupabase();
    const { data: user } = await sb
      .from("whatsapp_users")
      .select("id, language")
      .or(`whatsapp_number.eq.${ctx.phone},whatsapp_number.eq.+${ctx.phone}`)
      .maybeSingle();

    if (user) {
      const { data: patients } = await sb
        .from("patient_id")
        .select("id, patient_name, ic_passport")
        .eq("wa_user_id", user.id);

      const patientRefs = (patients ?? []).map((p) => ({
        id: p.id,
        name: p.patient_name,
        ic: p.ic_passport ?? "",
      }));

      await ctx.updateThread({
        userId: user.id,
        patients: patientRefs,
        activePatientId: patientRefs.length === 1 ? patientRefs[0].id : undefined,
        language: user.language ?? undefined,
      });
      // Refresh local state object for the remainder of this function
      ctx.thread.userId = user.id;
    }
  }

  switch (action.kind) {
    case "mute_clinic": {
      await muteClinic(ctx.phone, action.clinicId, "button");
      const name = await clinicName(action.clinicId);
      await ctx.replyText(
        `Reminders from ${name} muted. You can re-enable them anytime by booking again or typing "resume reminders".`,
      );
      return { handled: true };
    }
    case "unmute_clinic": {
      await unmuteClinic(ctx.phone, action.clinicId);
      const name = await clinicName(action.clinicId);
      await ctx.replyText(`Reminders from ${name} resumed.`);
      return { handled: true };
    }
    case "view_booking": {
      await ctx.updateThread({ activeBookingId: action.bookingId });
      return { handled: false, hint: `User tapped "View booking" for booking ${action.bookingId}. Call get_booking_details to load it and summarise it for the user.` };
    }
    case "get_doc": {
      await ctx.updateThread({ pendingDocRetrievalBookingId: action.bookingId });
      return { handled: false, hint: `User tapped "Get document" for booking ${action.bookingId}. Verify identity if needed, then run document retrieval for that booking.` };
    }
  }
}

async function clinicName(clinicId: string): Promise<string> {
  const sb = getSupabase();
  const { data } = await sb.from("c_a_clinics").select("name").eq("id", clinicId).maybeSingle();
  return (data?.name as string) ?? "the clinic";
}
