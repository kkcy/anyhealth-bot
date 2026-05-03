export type ReminderKind = "appt_24h" | "appt_2h" | "doc_ready";

export interface BookingForReminder {
  id: string;
  user_id: string;
  clinic_id: string;
  doctor_name: string | null;     // null when no doctor selection at clinic
  patient_name: string;            // best display name we have for the user/patient
  clinic_name: string;
  phone: string;                   // E.164 without "+"
  status: string;                  // c_s_bookings.status
  appointment_at: Date;            // composed from new_date+new_time OR original_date+original_time
}

export interface ReminderJobRow {
  id: string;
  booking_id: string;
  user_id: string;
  clinic_id: string;
  phone: string;
  kind: ReminderKind;
  template_name: string;
  template_vars: Record<string, string>;
  send_at: string;                 // ISO timestamptz
  sent_at: string | null;
  attempts: number;
  last_error: string | null;
  failed_at: string | null;
}
