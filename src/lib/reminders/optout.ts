import { getSupabase } from "../supabase";

export type OptoutSource = "button" | "command" | "auto_block";

export async function isMuted(phone: string, clinicId: string): Promise<boolean> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("reminder_optouts")
    .select("clinic_id")
    .eq("phone", phone)
    .or(`clinic_id.eq.${clinicId},clinic_id.is.null`)
    .limit(1);
  if (error) {
    console.error("[REMINDER] isMuted error:", error.message);
    return false; // fail-open on read error so reminders aren't silently dropped
  }
  return (data?.length ?? 0) > 0;
}

export async function muteClinic(
  phone: string,
  clinicId: string,
  source: OptoutSource,
): Promise<void> {
  const sb = getSupabase();
  await sb
    .from("reminder_optouts")
    .upsert(
      { phone, clinic_id: clinicId, source },
      { onConflict: "phone,clinic_id" },
    );
}

export async function muteGlobally(
  phone: string,
  source: OptoutSource = "auto_block",
): Promise<void> {
  const sb = getSupabase();
  await sb
    .from("reminder_optouts")
    .upsert(
      { phone, clinic_id: null, source },
      { onConflict: "phone,clinic_id" },
    );
}

export async function unmuteClinic(
  phone: string,
  clinicId: string,
  opts: { onlyButtonSource?: boolean } = {},
): Promise<void> {
  const sb = getSupabase();
  let q = sb.from("reminder_optouts")
    .delete()
    .eq("phone", phone)
    .eq("clinic_id", clinicId);
  if (opts.onlyButtonSource) q = q.eq("source", "button");
  await q;
}

/**
 * Returns clinic_ids the phone has muted via user-initiated actions
 * (button or command). Excludes auto_block / global mutes — those are
 * technical and not user-actionable from the bot UI.
 */
export async function listMutedClinics(phone: string): Promise<string[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("reminder_optouts")
    .select("clinic_id, source")
    .eq("phone", phone)
    .not("clinic_id", "is", null)
    .in("source", ["button", "command"]);
  if (error) return [];
  return (data ?? []).map((r) => r.clinic_id as string);
}
