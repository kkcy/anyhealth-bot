import { tool } from "ai";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import type { ThreadState } from "@/types";

function normalizeNewPatientLimit(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function hasOverlap(startA: number, durationA: number, startB: number, durationB: number): boolean {
  const endA = startA + durationA;
  const endB = startB + durationB;
  return startA < endB && startB < endA;
}

export function createBookingTools(
  state: ThreadState,
  updateState: (partial: Partial<ThreadState>) => Promise<void>
) {
  const supabase = getSupabase();

  return {
    create_booking: tool({
      description:
        "Create a new appointment booking. Reads patient, service, clinic, method, and doctor from current selections. " +
        "Call select_service first and include confirmation before finalizing.",
      inputSchema: z.object({
        date: z.string().describe("Appointment date in YYYY-MM-DD format"),
        time: z.string().optional().describe("Appointment time in HH:mm format (required if method requiresTime)"),
        address: z.string().max(500).optional().describe("Location for house calls (required if method requiresAddress)"),
        reminderRemark: z.string().max(2000).optional().describe("Reminder remark to show in booking summary"),
        details: z.string().max(2000).optional().describe("Deprecated alias for reminderRemark"),
        isNewPatient: z.boolean().optional().describe("Whether this is a new patient booking"),
        confirmed: z.boolean().describe("Must be true after user confirms all booking details"),
        bookingType: z.enum(["checkup", "consultation", "vaccination"]).default("consultation"),
      }),
      execute: async ({ date, time, address, reminderRemark, details, isNewPatient, confirmed, bookingType }) => {
        // All IDs come from state — no UUIDs from the LLM
        let patientId = state.activePatientId;
        let serviceId = state.activeServiceId;
        let clinicId = state.activeClinicId;
        let methodId = state.activeMethodId;
        let doctorId = state.activeDoctorId;

        if (!state.userId) {
          return JSON.stringify({ error: "Please start a conversation first. Call user_lookup." });
        }
        if (!patientId) {
          return JSON.stringify({ error: "No patient selected. Call user_lookup or select_patient first." });
        }
        if (!confirmed) {
          return JSON.stringify({ error: "Please confirm all booking details before finalizing the booking." });
        }

        // Auto-resolve missing selections when there's only one option
        if (!serviceId && state.serviceOptions?.length === 1) {
          const svc = state.serviceOptions[0];
          serviceId = svc.serviceId;
          methodId = svc.methods.length === 1 ? svc.methods[0].methodId : undefined;
          await updateState({ activeServiceId: serviceId, activeMethodId: methodId });
          console.log("[BOOKING] Auto-resolved service:", serviceId);
        }

        if (!clinicId && state.clinicOptions?.length === 1) {
          clinicId = state.clinicOptions[0].clinicId;
          await updateState({ activeClinicId: clinicId });
          console.log("[BOOKING] Auto-resolved clinic:", clinicId);
        }

        console.log("[BOOKING] State at create_booking:", JSON.stringify({
          userId: state.userId, patientId, serviceId, clinicId, methodId, doctorId,
        }));

        if (!serviceId || !clinicId) {
          return JSON.stringify({ error: "No service selected. Call select_service first." });
        }

        const clinicOpt = (state.clinicOptions ?? []).find((c) => c.clinicId === clinicId);
        let clinicDoctorSelection = clinicOpt?.doctorSelection ?? true;
        let newPatientLimit = clinicOpt?.newPatientLimit ?? null;

        // Best-effort fallback for live DB schema differences (doctor_selection vs dr_selection).
        const { data: clinicMeta } = await supabase
          .from("c_a_clinics")
          .select("*")
          .eq("id", clinicId)
          .maybeSingle();
        if (clinicMeta) {
          if (typeof clinicMeta.dr_selection === "boolean") {
            clinicDoctorSelection = clinicMeta.dr_selection;
          } else if (typeof clinicMeta.doctor_selection === "boolean") {
            clinicDoctorSelection = clinicMeta.doctor_selection;
          }
          newPatientLimit = normalizeNewPatientLimit(clinicMeta.new_patient_limit);
        }

        const { data: clinicDoctors, error: doctorLoadError } = await supabase
          .from("c_a_doctors")
          .select("id, name")
          .eq("clinic_id", clinicId)
          .order("name", { ascending: true });
        if (doctorLoadError) {
          return JSON.stringify({ error: "Failed to load clinic doctors", detail: doctorLoadError.message });
        }

        const doctors = clinicDoctors ?? [];
        if (doctors.length === 0) {
          return JSON.stringify({ error: "No doctors found for this clinic." });
        }

        if (doctorId && !doctors.some((d) => d.id === doctorId)) {
          return JSON.stringify({ error: "Selected doctor does not belong to the selected clinic." });
        }

        if (!doctorId) {
          if (clinicDoctorSelection && doctors.length > 1) {
            return JSON.stringify({
              error: "This clinic requires doctor selection. Call select_doctor first.",
              doctors: doctors.map((d, i) => ({ index: i + 1, name: d.name })),
            });
          }
          doctorId = doctors[0].id;
          await updateState({ activeDoctorId: doctorId });
          console.log("[BOOKING] Auto-assigned doctor:", doctorId);
        }

        const patient = state.patients?.find((p) => p.id === patientId);
        if (!patient) {
          return JSON.stringify({ error: "Patient not found in state." });
        }

        // Get service duration
        let { data: service } = await supabase
          .from("c_a_clinic_service")
          .select("service_name, duration_minutes")
          .eq("id", serviceId)
          .maybeSingle();

        if (!service) {
          ({ data: service } = await supabase
            .from("tcm_a_clinic_service")
            .select("service_name, duration_minutes")
            .eq("id", serviceId)
            .maybeSingle());
        }

        // Validate conditional fields
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

        if (!doctorId) {
          return JSON.stringify({ error: "No doctor selected. Call select_doctor first." });
        }

        const appointmentDuration = service?.duration_minutes ?? 30;
        const finalReminderRemark = (reminderRemark ?? details)?.trim() || null;

        if (newPatientLimit !== null && isNewPatient === undefined) {
          return JSON.stringify({
            error: "This clinic has a new-patient slot limit. Please confirm whether this is a new patient booking.",
          });
        }

        const finalIsNewPatient = isNewPatient ?? false;
        if (newPatientLimit !== null && finalIsNewPatient) {
          if (!time) {
            return JSON.stringify({
              error: "New patient slot limit requires a specific time. Please provide time in HH:mm format.",
            });
          }

          const requestedStart = parseTimeToMinutes(time);
          if (requestedStart === null) {
            return JSON.stringify({ error: "Invalid time format. Please provide time in HH:mm format." });
          }

          const clinicDoctorIds = doctors.map((d) => d.id);
          const { data: existingNewPatientBookings, error: existingError } = await supabase
            .from("c_s_bookings")
            .select("id, doctor_id, original_time, new_time, duration_minutes")
            .or(`original_date.eq.${date},new_date.eq.${date}`)
            .not("status", "in", "(cancelled,declined)")
            .eq("new_patient", true)
            .in("doctor_id", clinicDoctorIds);
          if (existingError) {
            return JSON.stringify({
              error: "Failed to validate new-patient slot limit",
              detail: existingError.message,
            });
          }

          let overlappingNewPatientCount = 0;
          for (const booking of existingNewPatientBookings ?? []) {
            const slotTime = booking.new_time ?? booking.original_time;
            const bookingStart = slotTime ? parseTimeToMinutes(slotTime) : null;
            if (bookingStart === null) continue;
            const bookingDuration = booking.duration_minutes && booking.duration_minutes > 0
              ? booking.duration_minutes
              : 30;
            if (hasOverlap(requestedStart, appointmentDuration, bookingStart, bookingDuration)) {
              overlappingNewPatientCount += 1;
            }
          }

          if (overlappingNewPatientCount >= newPatientLimit) {
            return JSON.stringify({
              error: `New patient limit reached for ${time}. Please choose another time slot.`,
              limit: newPatientLimit,
              currentNewPatientsInSlot: overlappingNewPatientCount,
            });
          }
        }

        const payload = {
          user_id: state.userId,
          doctor_id: doctorId,
          service_id: serviceId,
          booking_type: bookingType,
          details: finalReminderRemark,
          original_date: date,
          original_time: time ?? "00:00",
          status: "pending",
          duration_minutes: appointmentDuration,
          method_id: methodId || null,
          address: address?.trim() || null,
          new_patient: finalIsNewPatient,
        };

        const { data: booking, error } = await supabase
          .from("c_s_bookings")
          .insert(payload)
          .select("id, original_date, original_time, status, details, new_patient")
          .single();

        if (error) {
          return JSON.stringify({ error: "Failed to create booking", detail: error.message });
        }

        // Fetch doctor and clinic names for confirmation
        const [{ data: doctor }, { data: clinic }] = await Promise.all([
          supabase.from("c_a_doctors").select("name").eq("id", doctorId).maybeSingle(),
          supabase.from("c_a_clinics").select("name, address").eq("id", clinicId).maybeSingle(),
        ]);

        // Clear booking selections to prevent duplicate bookings in the same turn
        // and to allow a fresh search if the user starts a new booking flow
        await updateState({
          activeClinicId: undefined,
          activeServiceId: undefined,
          activeMethodId: undefined,
          activeDoctorId: undefined,
          clinicOptions: undefined,
          serviceOptions: undefined,
          doctorOptions: undefined,
        });

        return JSON.stringify({
          success: true,
          bookingId: booking.id,
          date: booking.original_date,
          time: booking.original_time,
          status: booking.status,
          isNewPatient: booking.new_patient,
          reminderRemark: booking.details,
          patientName: patient.name,
          serviceName: service?.service_name ?? null,
          doctorName: doctor?.name ?? null,
          clinicName: clinic?.name ?? null,
          clinicAddress: clinic?.address ?? null,
          message: "Booking created successfully. The clinic will confirm your appointment.",
        });
      },
    }),

    view_bookings: tool({
      description:
        "View upcoming bookings for the user's patients. " +
        "Shows all bookings that are not cancelled or declined.",
      inputSchema: z.object({
        patientId: z.string().optional().describe("Exact patient UUID from user_lookup to filter by"),
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

        // Fetch clinic names for all bookings
        const clinicIds = [...new Set(
          bookings.map((b) => (b.doctor as any)?.clinic_id).filter(Boolean)
        )];
        let clinicMap: Record<string, string> = {};
        if (clinicIds.length > 0) {
          const { data: clinics } = await supabase
            .from("c_a_clinics")
            .select("id, name")
            .in("id", clinicIds);
          if (clinics) {
            clinicMap = Object.fromEntries(clinics.map((c) => [c.id, c.name]));
          }
        }

        const results = bookings.map((b) => {
          const doctor = b.doctor as any;
          return {
            bookingId: b.id,
            date: b.new_date ?? b.original_date,
            time: b.new_time ?? b.original_time,
            status: b.status,
            type: b.booking_type,
            service: b.service,
            doctorName: doctor?.name ?? null,
            clinicName: doctor?.clinic_id ? clinicMap[doctor.clinic_id] ?? null : null,
            details: b.details,
            reminderRemark: b.details,
            address: b.address,
          };
        });

        return JSON.stringify({ found: true, bookings: results });
      },
    }),

    reschedule_booking: tool({
      description:
        "Reschedule an existing booking to a new date and/or time. " +
        "Sets status to 'reschedule_pending' for clinic confirmation.",
      inputSchema: z.object({
        bookingId: z.string().describe("Exact booking UUID from view_bookings results"),
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
        bookingId: z.string().describe("Exact booking UUID from view_bookings results"),
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
