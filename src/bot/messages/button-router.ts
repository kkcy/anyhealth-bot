import { muteClinic, unmuteClinic } from "@/lib/reminders/optout";
import { getSupabase } from "@/lib/supabase";
import type { ThreadState } from "@/types";
import { chooseWaUserCandidate, phoneLookupVariants } from "../phone-user";

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

type ButtonPatientRow = {
  id: string;
  patient_name: string;
  ic_passport?: string | null;
  wa_user_id?: string | null;
};

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
    const variants = phoneLookupVariants(ctx.phone);
    const { data: users } = await sb
      .from("wa_user")
      .select("id, phone_number, language")
      .in("phone_number", variants);

    if ((users ?? []).length > 0) {
      const userIds = (users ?? []).map((u) => u.id);
      const { data: patients } = await sb
        .from("patient")
        .select("id, patient_name, ic_passport, wa_user_id")
        .in("wa_user_id", userIds);

      const patientsByUser = new Map<string, ButtonPatientRow[]>();
      for (const p of (patients ?? []) as ButtonPatientRow[]) {
        if (!p.wa_user_id) continue;
        const rows = patientsByUser.get(p.wa_user_id) ?? [];
        rows.push(p);
        patientsByUser.set(p.wa_user_id, rows);
      }

      const chosen = chooseWaUserCandidate(
        (users ?? []).map((u) => ({
          id: u.id,
          phone_number: u.phone_number,
          language: u.language ?? null,
          patientCount: patientsByUser.get(u.id)?.length ?? 0,
        })),
        ctx.phone
      );
      const user = chosen ? (users ?? []).find((u) => u.id === chosen.id) : null;
      const selectedPatients = user ? patientsByUser.get(user.id) ?? [] : [];

      const patientRefs = selectedPatients.map((p) => ({
        id: p.id,
        name: p.patient_name,
        ic: p.ic_passport ?? "",
      }));

      if (user) {
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
