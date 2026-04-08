import { tool } from "ai";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import type { ThreadState } from "@/types";

export function createBookingTools(
  state: ThreadState,
  updateState: (partial: Partial<ThreadState>) => Promise<void>
) {
  const supabase = getSupabase();

  return {
    create_booking: tool({
      description:
        "Create a new appointment booking. Requires patient selection first. " +
        "The 'time' field is required if the service method has requiresTime=true. " +
        "The 'address' field is required if the service method has requiresAddress=true.",
      inputSchema: z.object({
        patientId: z.string().uuid().describe("Patient ID to book for"),
        clinicId: z.string().uuid().describe("Clinic ID"),
        serviceId: z.string().uuid().describe("Service ID from search_services"),
        methodId: z.string().uuid().optional().describe("Service method ID (if service has methods)"),
        doctorId: z.string().uuid().describe("Doctor ID"),
        date: z.string().describe("Appointment date in YYYY-MM-DD format"),
        time: z.string().optional().describe("Appointment time in HH:mm format (required if method.requiresTime)"),
        address: z.string().max(500).optional().describe("Location for house calls (required if method.requiresAddress)"),
        details: z.string().max(2000).optional().describe("Additional notes or details"),
        bookingType: z.enum(["checkup", "consultation", "vaccination"]).default("consultation"),
      }),
      execute: async ({ patientId, clinicId, serviceId, methodId, doctorId, date, time, address, details, bookingType }) => {
        if (!state.userId) {
          return JSON.stringify({ error: "Please start a conversation first. Call user_lookup." });
        }

        // Verify patient belongs to this user
        const patient = state.patients?.find((p) => p.id === patientId);
        if (!patient) {
          return JSON.stringify({ error: "Patient not found. Please call user_lookup first." });
        }

        // Get service duration (check both clinic and TCM tables)
        let { data: service } = await supabase
          .from("c_a_clinic_service")
          .select("duration_minutes")
          .eq("id", serviceId)
          .maybeSingle();

        if (!service) {
          ({ data: service } = await supabase
            .from("tcm_a_clinic_service")
            .select("duration_minutes")
            .eq("id", serviceId)
            .maybeSingle());
        }

        // Validate conditional fields if method is specified
        if (methodId) {
          const { data: method } = await supabase
            .from("c_a_service_method")
            .select("priority, address")
            .eq("id", methodId)
            .maybeSingle();

          if (method?.priority && !time) {
            return JSON.stringify({ error: "This service method requires a time. Please provide a time in HH:mm format." });
          }
          if (method?.address && !address) {
            return JSON.stringify({ error: "This service method requires an address (e.g., for house calls). Please provide a location." });
          }
        }

        const payload = {
          user_id: state.userId,
          doctor_id: doctorId,
          service_id: serviceId,
          booking_type: bookingType,
          details: details?.trim() || null,
          original_date: date,
          original_time: time ?? "00:00",
          status: "pending",
          duration_minutes: service?.duration_minutes ?? 30,
          method_id: methodId || null,
          address: address?.trim() || null,
          new_patient: false,
        };

        const { data: booking, error } = await supabase
          .from("c_s_bookings")
          .insert(payload)
          .select("id, original_date, original_time, status")
          .single();

        if (error) {
          return JSON.stringify({ error: "Failed to create booking", detail: error.message });
        }

        await updateState({ activePatientId: patientId });

        return JSON.stringify({
          success: true,
          bookingId: booking.id,
          date: booking.original_date,
          time: booking.original_time,
          status: booking.status,
          patientName: patient.name,
          message: "Booking created successfully. The clinic will confirm your appointment.",
        });
      },
    }),

    view_bookings: tool({
      description:
        "View upcoming bookings for the user's patients. " +
        "Shows all bookings that are not cancelled or declined.",
      inputSchema: z.object({
        patientId: z.string().uuid().optional().describe("Filter by specific patient ID"),
      }),
      execute: async ({ patientId }) => {
        if (!state.userId) {
          return JSON.stringify({ error: "Please start a conversation first. Call user_lookup." });
        }

        const query = supabase
          .from("c_s_bookings")
          .select(`
            id, original_date, original_time, new_date, new_time, status, details, address,
            booking_type, duration_minutes,
            doctor:doctor_id(id, name, clinic_id),
            service:service_id(id, service_name, category)
          `)
          .eq("user_id", state.userId)
          .not("status", "in", "(cancelled,declined)")
          .gte("original_date", new Date().toISOString().split("T")[0])
          .order("original_date", { ascending: true })
          .order("original_time", { ascending: true })
          .limit(20);

        const { data: bookings, error } = await query;

        if (error) {
          return JSON.stringify({ error: "Failed to load bookings", detail: error.message });
        }

        if (!bookings || bookings.length === 0) {
          return JSON.stringify({ found: false, message: "No upcoming bookings found." });
        }

        const results = bookings.map((b) => ({
          bookingId: b.id,
          date: b.new_date ?? b.original_date,
          time: b.new_time ?? b.original_time,
          status: b.status,
          type: b.booking_type,
          service: b.service,
          doctor: b.doctor,
          details: b.details,
          address: b.address,
        }));

        return JSON.stringify({ found: true, bookings: results });
      },
    }),

    reschedule_booking: tool({
      description:
        "Reschedule an existing booking to a new date and/or time. " +
        "Sets status to 'reschedule_pending' for clinic confirmation.",
      inputSchema: z.object({
        bookingId: z.string().uuid().describe("The booking ID to reschedule"),
        newDate: z.string().describe("New date in YYYY-MM-DD format"),
        newTime: z.string().optional().describe("New time in HH:mm format"),
      }),
      execute: async ({ bookingId, newDate, newTime }) => {
        if (!state.userId) {
          return JSON.stringify({ error: "Please start a conversation first." });
        }

        // Verify booking belongs to this user
        const { data: existing, error: fetchError } = await supabase
          .from("c_s_bookings")
          .select("id, user_id, status, original_date, original_time")
          .eq("id", bookingId)
          .eq("user_id", state.userId)
          .single();

        if (fetchError || !existing) {
          return JSON.stringify({ error: "Booking not found or does not belong to you." });
        }

        if (existing.status === "cancelled" || existing.status === "declined") {
          return JSON.stringify({ error: `Cannot reschedule a ${existing.status} booking.` });
        }

        const updatePayload: Record<string, unknown> = {
          new_date: newDate,
          status: "reschedule_pending",
          updated_at: new Date().toISOString(),
        };
        if (newTime) {
          updatePayload.new_time = newTime;
        }

        const { error: updateError } = await supabase
          .from("c_s_bookings")
          .update(updatePayload)
          .eq("id", bookingId);

        if (updateError) {
          return JSON.stringify({ error: "Failed to reschedule", detail: updateError.message });
        }

        return JSON.stringify({
          success: true,
          bookingId,
          newDate,
          newTime: newTime ?? "same as before",
          status: "reschedule_pending",
          message: "Reschedule request submitted. The clinic will confirm the new time.",
        });
      },
    }),

    cancel_booking: tool({
      description: "Cancel an existing booking.",
      inputSchema: z.object({
        bookingId: z.string().uuid().describe("The booking ID to cancel"),
      }),
      execute: async ({ bookingId }) => {
        if (!state.userId) {
          return JSON.stringify({ error: "Please start a conversation first." });
        }

        const { data: existing, error: fetchError } = await supabase
          .from("c_s_bookings")
          .select("id, user_id, status")
          .eq("id", bookingId)
          .eq("user_id", state.userId)
          .single();

        if (fetchError || !existing) {
          return JSON.stringify({ error: "Booking not found or does not belong to you." });
        }

        if (existing.status === "cancelled") {
          return JSON.stringify({ message: "This booking is already cancelled." });
        }

        const { error: updateError } = await supabase
          .from("c_s_bookings")
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("id", bookingId);

        if (updateError) {
          return JSON.stringify({ error: "Failed to cancel", detail: updateError.message });
        }

        return JSON.stringify({
          success: true,
          bookingId,
          status: "cancelled",
          message: "Booking cancelled successfully.",
        });
      },
    }),
  };
}
