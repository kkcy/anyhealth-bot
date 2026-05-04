import { getSupabase } from "../supabase";
import type { BookingForReminder } from "./types";

type ReminderLoaderClient = ReturnType<typeof getSupabase>;

/**
 * Loads a c_s_bookings row joined with the data the reminder layer needs:
 * - clinic (via service_info_id -> c_a_service_info -> c_a_service_list -> c_a_clinics)
 * - doctor name
 * - user phone (via wa_user.phone_number)
 *
 * Returns null if the booking doesn't exist or is missing required relations.
 *
 * Composes appointment_at from reschedule_date+reschedule_time when present,
 * else original_date+original_time.
 */
export async function getBookingForReminder(
  bookingId: string,
): Promise<BookingForReminder | null> {
  return getBookingForReminderWithClient(getSupabase(), bookingId);
}

export async function getBookingForReminderWithClient(
  sb: ReminderLoaderClient,
  bookingId: string,
): Promise<BookingForReminder | null> {
  const { data: b, error } = await sb
    .from("c_s_bookings")
    .select(`
      id, wa_user_id, status,
      original_date, original_time, reschedule_date, reschedule_time,
      service_info:service_info_id(
        id,
        doctor:doctor_id(id, name, clinic_id),
        service:service_id(id, clinic_id, service_name)
      )
    `)
    .eq("id", bookingId)
    .maybeSingle();

  if (error || !b) return null;
  const serviceInfo = b.service_info as unknown as {
    id: string;
    doctor: { id: string; name: string; clinic_id: string } | null;
    service: { id: string; clinic_id: string; service_name: string } | null;
  } | null;
  const clinicId = serviceInfo?.service?.clinic_id ?? serviceInfo?.doctor?.clinic_id;
  if (!clinicId) return null;

  const [{ data: clinic }, { data: user }] = await Promise.all([
    sb.from("c_a_clinics").select("id, name").eq("id", clinicId).maybeSingle(),
    sb.from("wa_user")
      .select("id, phone_number, username")
      .eq("id", b.wa_user_id)
      .maybeSingle(),
  ]);
  if (!clinic || !user?.phone_number) return null;

  const date = b.reschedule_date ?? b.original_date;     // YYYY-MM-DD
  const time = b.reschedule_time ?? b.original_time;     // HH:MM:SS or HH:MM
  // Treat the stored date+time as Asia/Kuala_Lumpur local (UTC+8), no DST.
  const apptIso = `${date}T${normalizeTime(time)}+08:00`;
  const appointment_at = new Date(apptIso);

  return {
    id: b.id,
    user_id: b.wa_user_id,
    clinic_id: clinicId,
    doctor_name: serviceInfo?.doctor?.name ?? null,
    patient_name: (user.username as string) ?? "there",
    clinic_name: clinic.name as string,
    phone: stripPlus(user.phone_number as string),
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
