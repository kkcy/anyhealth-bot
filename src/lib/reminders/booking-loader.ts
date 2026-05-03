import { getSupabase } from "../supabase";
import type { BookingForReminder } from "./types";

/**
 * Loads a c_s_bookings row joined with the data the reminder layer needs:
 * - clinic (via doctor_id -> c_a_doctors.clinic_id -> c_a_clinics)
 * - doctor name
 * - user phone (via whatsapp_users.whatsapp_number)
 *
 * Returns null if the booking doesn't exist or is missing required relations.
 *
 * Composes appointment_at from new_date+new_time when present (rescheduled),
 * else original_date+original_time.
 */
export async function getBookingForReminder(
  bookingId: string,
): Promise<BookingForReminder | null> {
  const sb = getSupabase();

  const { data: b, error } = await sb
    .from("c_s_bookings")
    .select(`
      id, user_id, status,
      original_date, original_time, new_date, new_time,
      doctor:doctor_id(id, name, clinic_id)
    `)
    .eq("id", bookingId)
    .maybeSingle();

  if (error || !b) return null;
  const doctor = b.doctor as { id: string; name: string; clinic_id: string } | null;
  if (!doctor?.clinic_id) return null;

  const [{ data: clinic }, { data: user }] = await Promise.all([
    sb.from("c_a_clinics").select("id, name").eq("id", doctor.clinic_id).maybeSingle(),
    sb.from("whatsapp_users")
      .select("id, whatsapp_number, name")
      .eq("id", b.user_id)
      .maybeSingle(),
  ]);
  if (!clinic || !user?.whatsapp_number) return null;

  const date = b.new_date ?? b.original_date;     // YYYY-MM-DD
  const time = b.new_time ?? b.original_time;     // HH:MM:SS or HH:MM
  // Treat the stored date+time as Asia/Kuala_Lumpur local (UTC+8), no DST.
  const apptIso = `${date}T${normalizeTime(time)}+08:00`;
  const appointment_at = new Date(apptIso);

  return {
    id: b.id,
    user_id: b.user_id,
    clinic_id: doctor.clinic_id,
    doctor_name: doctor.name ?? null,
    patient_name: (user.name as string) ?? "there",
    clinic_name: clinic.name as string,
    phone: stripPlus(user.whatsapp_number as string),
    status: b.status as string,
    appointment_at,
  };
}

function normalizeTime(t: string): string {
  // "HH:MM" -> "HH:MM:00", "HH:MM:SS" -> unchanged
  return t.length === 5 ? `${t}:00` : t;
}

function stripPlus(p: string): string {
  return p.startsWith("+") ? p.slice(1) : p;
}
