import { getSupabase } from "../lib/supabase";

export type ResolvedClinic = { id: string; name: string };

/**
 * Looks up a clinic by its URL-safe slug. Returns null if no match.
 */
export async function resolveClinicBySlug(slug: string): Promise<ResolvedClinic | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("c_a_clinics")
    .select("id, name")
    .eq("slug", slug)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[DEEP-LINK] resolver error slug=${slug}:`, error.message);
    return null;
  }
  if (!data) return null;
  return { id: data.id, name: data.name };
}

/**
 * Looks up a clinic by exact (case-insensitive) name. Returns null on miss
 * or when the name is ambiguous (multiple rows match) — the caller should
 * fall through to the LLM rather than guess.
 */
export async function resolveClinicByName(name: string): Promise<ResolvedClinic | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("c_a_clinics")
    .select("id, name")
    .ilike("name", trimmed)
    .limit(2);

  if (error) {
    console.error(`[DEEP-LINK] resolveClinicByName error name=${trimmed}:`, error.message);
    return null;
  }
  if (!data || data.length === 0) return null;
  if (data.length > 1) {
    console.warn(`[DEEP-LINK] ambiguous clinic name=${trimmed} matches=${data.length}`);
    return null;
  }
  return { id: data[0].id, name: data[0].name };
}
