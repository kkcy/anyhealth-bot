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
