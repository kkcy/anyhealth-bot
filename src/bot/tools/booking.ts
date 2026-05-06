import { tool } from "ai";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import type { ThreadState } from "@/types";
import { recomputeReminders } from "@/lib/reminders/scheduler";

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

type IntentArgs = {
  serviceKeyword?: string;
  date?: string;
  time?: string;
  method?: "in_clinic" | "house_call" | "video";
  isNewPatient?: boolean;
};

function isPastDate(iso: string): boolean {
  const tz = process.env.CLINIC_TIMEZONE || "Asia/Kuala_Lumpur";
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const todayIso = fmt.format(now);
  return iso < todayIso;
}

function normalizeKeyword(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function isDifferentServiceKeyword(state: ThreadState, args: IntentArgs): boolean {
  if (args.serviceKeyword === undefined) return false;
  const existing = normalizeKeyword(
    state.extractedIntent?.serviceKeyword ?? state.lastSearchQuery
  );
  const incoming = normalizeKeyword(args.serviceKeyword);
  if (!existing || !incoming) return false;
  // Same service if either string contains the other (handles "gp" vs
  // "general consultation"); different service implies re-entry.
  return !(existing === incoming || existing.includes(incoming) || incoming.includes(existing));
}

function isReentryAttempt(state: ThreadState, args: IntentArgs): boolean {
  if (!state.activeClinicId) return false;
  return isDifferentServiceKeyword(state, args);
}

function evaluateIntentGuard(state: ThreadState, args: IntentArgs): string | null {
  const hasConfirmCardDiff =
    !!state.pendingBooking &&
    ((args.time !== undefined && args.time !== state.pendingBooking.time) ||
      (args.date !== undefined && args.date !== state.pendingBookingDate) ||
      (args.isNewPatient !== undefined && args.isNewPatient !== state.pendingIsNewPatient));

  if (hasConfirmCardDiff) return null;

  if (state.pendingBooking) return "pendingBooking";
  if (state.activeBookingId) return "activeBookingId";
  if (state.pendingDocRetrievalBookingId) return "pendingDocRetrievalBookingId";
  if (state.activeServiceId) return "activeServiceId";
  // Mid-flow with a clinic selected: only block when the user is starting a
  // *different* booking (different service keyword). Slot-only updates and
  // same-service refinements fall through so the in-flight booking can
  // continue.
  if (isReentryAttempt(state, args)) return "activeClinicId";
  if (state.awaitingAddress) return "awaitingAddress";
  if (state.awaitingTime) return "awaitingTime";
  if (state.awaitingDate) return "awaitingDate";
  if (state.awaitingDocVerification) return "awaitingDocVerification";
  if (state.awaitingRemark) return "awaitingRemark";

  return null;
}

const IN_PROGRESS_BOOKING_REASONS: ReadonlySet<string> = new Set([
  "pendingBooking",
  "activeBookingId",
  "activeServiceId",
  "activeClinicId",
  "awaitingAddress",
  "awaitingTime",
  "awaitingDate",
  "awaitingRemark",
]);

type ServiceInfoForBooking = {
  id: string;
  price: number | null;
  duration: number | null;
  reminder_remark: string | null;
  doctor_id: string | null;
  method_id: string | null;
  service: { id: string; clinic_id: string; service_name: string; description?: string | null } | null;
  doctor: { id: string; name: string; clinic_id: string } | null;
  method: { id: string; method: string; time_required: number | boolean | null; address_required: boolean | null } | null;
};

function serviceInfoSelect() {
  return `
    id, price, duration, reminder_remark, doctor_id, method_id,
    service:service_id(id, clinic_id, service_name, description),
    doctor:doctor_id(id, name, clinic_id),
    method:method_id(id, method, time_required, address_required)
  `;
}

export function createBookingTools(
  state: ThreadState,
  updateState: (partial: Partial<ThreadState>) => Promise<void>
) {
  const supabase = getSupabase();

  return {
    create_booking: tool({
      description:
        "Create a new appointment booking. Reads patient, service, clinic, method, and doctor from current selections.\n" +
        "TWO-STEP PATTERN — always follow:\n" +
        "1. After all details are gathered (date, time, address if needed), call this tool with `confirmed: false` and ALL args. " +
        "The system will then surface Yes/No confirm buttons to the user. Do NOT also send a free-text 'please confirm' message.\n" +
        "2. The user's Yes tap is handled by the system and re-runs this tool with `confirmed: true` automatically. " +
        "Never call with `confirmed: true` yourself unless the user typed an explicit confirmation in plain text.",
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
        let serviceId = state.activeServiceId;
        let clinicId = state.activeClinicId;
        let methodId = state.activeMethodId;
        let doctorId = state.activeDoctorId;

        if (!state.userId) {
          // Auto-bootstrap the wa_user when the LLM jumped straight to booking
          // without calling user_lookup. user_lookup itself upserts on phone,
          // so we replicate the minimal write here to keep the booking flow
          // resilient.
          if (!state.phone) {
            return JSON.stringify({ error: "Could not determine sender identity. WhatsApp is required." });
          }
          const canonicalPhone = state.phone.startsWith("+") ? state.phone : `+${state.phone}`;
          const { data: user, error: userError } = await supabase
            .from("wa_user")
            .upsert(
              { phone_number: canonicalPhone, username: canonicalPhone },
              { onConflict: "phone_number" }
            )
            .select("id")
            .single();
          if (userError || !user) {
            return JSON.stringify({
              error: "Failed to initialize user for booking",
              detail: userError?.message ?? "unknown",
            });
          }
          await updateState({ userId: user.id });
        }
        if (!confirmed) {
          // Stage the args so the deterministic Yes/No button can finalize.
          await updateState({
            pendingBooking: {
              date,
              time,
              address,
              reminderRemark: (reminderRemark ?? details) ?? undefined,
              isNewPatient,
              bookingType,
            },
          });
          return JSON.stringify({
            needsConfirmation: true,
            date,
            time: time ?? null,
            address: address ?? null,
            instruction:
              "Show the user a summary of the booking and ask them to confirm. " +
              "The system will surface Yes/No buttons; do not call create_booking again until they confirm.",
          });
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
          userId: state.userId, serviceId, clinicId, methodId, doctorId,
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
          .from("c_a_doctor")
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

        if (!doctorId && clinicDoctorSelection) {
          if (doctors.length > 1) {
            return JSON.stringify({
              error: "This clinic requires doctor selection. Call select_doctor first.",
              doctors: doctors.map((d, i) => ({ index: i + 1, name: d.name })),
            });
          }
          doctorId = doctors[0].id;
          await updateState({ activeDoctorId: doctorId });
          console.log("[BOOKING] Auto-assigned doctor:", doctorId);
        }

        const patient = state.activePatientId
          ? state.patients?.find((p) => p.id === state.activePatientId)
          : undefined;

        let serviceInfoQuery = supabase
          .from("c_a_service_info")
          .select(serviceInfoSelect())
          .eq("service_id", serviceId);
        if (methodId) serviceInfoQuery = serviceInfoQuery.eq("method_id", methodId);
        if (doctorId) serviceInfoQuery = serviceInfoQuery.eq("doctor_id", doctorId);

        const { data: serviceInfoRows, error: serviceInfoError } = await serviceInfoQuery;
        if (serviceInfoError) {
          return JSON.stringify({ error: "Failed to load service details", detail: serviceInfoError.message });
        }
        const matchingInfos = ((serviceInfoRows ?? []) as unknown as ServiceInfoForBooking[])
          .filter((info) => info.service?.clinic_id === clinicId);
        const serviceInfo = matchingInfos[0];
        if (!serviceInfo) {
          return JSON.stringify({ error: "Selected service is not available at this clinic." });
        }

        const selectedMethod = serviceInfo.method;
        if (selectedMethod?.time_required && !time) {
          return JSON.stringify({ error: "This service method requires a time. Please provide a time in HH:mm format." });
        }
        if (selectedMethod?.address_required && !address) {
          return JSON.stringify({ error: "This service method requires an address. Please provide a location." });
        }

        doctorId = serviceInfo.doctor_id ?? doctorId;
        methodId = serviceInfo.method_id ?? methodId;

        if (!doctorId) {
          return JSON.stringify({ error: "No doctor selected. Call select_doctor first." });
        }

        const appointmentDuration = serviceInfo.duration ?? 30;
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

          const { data: existingNewPatientBookings, error: existingError } = await supabase
            .from("c_s_bookings")
            .select(`
              id, original_time, reschedule_time, status,
              service_info:service_info_id(duration, doctor_id)
            `)
            .or(`original_date.eq.${date},reschedule_date.eq.${date}`)
            .not("status", "in", "(cancelled,declined)");
          if (existingError) {
            return JSON.stringify({
              error: "Failed to validate new-patient slot limit",
              detail: existingError.message,
            });
          }

          let overlappingNewPatientCount = 0;
          for (const booking of existingNewPatientBookings ?? []) {
            const info = (booking as any).service_info;
            if (info?.doctor_id !== doctorId) continue;
            const slotTime = (booking as any).reschedule_time ?? booking.original_time;
            const bookingStart = slotTime ? parseTimeToMinutes(slotTime) : null;
            if (bookingStart === null) continue;
            const bookingDuration = info?.duration && info.duration > 0 ? info.duration : 30;
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
          wa_user_id: state.userId,
          service_info_id: serviceInfo.id,
          remark: finalReminderRemark,
          original_date: date,
          original_time: time ?? "00:00",
          status: "pending",
          address: address?.trim() || null,
        };

        const { data: booking, error } = await supabase
          .from("c_s_bookings")
          .insert(payload)
          .select("id, original_date, original_time, status, remark")
          .single();

        if (error) {
          return JSON.stringify({ error: "Failed to create booking", detail: error.message });
        }

        // Fetch doctor and clinic names for confirmation
        const [{ data: doctor }, { data: clinic }] = await Promise.all([
          supabase.from("c_a_doctor").select("name").eq("id", doctorId).maybeSingle(),
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
          pendingBooking: undefined,
          pendingBookingDate: undefined,
          pendingIsNewPatient: undefined,
          awaitingAddress: undefined,
          awaitingTime: undefined,
          awaitingDate: undefined,
          extractedIntent: undefined,
        });

        // Best-effort reminder enqueue. Never blocks user-facing booking confirmation.
        recomputeReminders(booking.id).catch((e) => {
          console.error("[REMINDER] recompute after create failed:", e);
        });

        return JSON.stringify({
          success: true,
          bookingId: booking.id,
          date: booking.original_date,
          time: booking.original_time,
          status: booking.status,
          isNewPatient: finalIsNewPatient,
          reminderRemark: booking.remark,
          patientName: patient?.name ?? null,
          serviceName: serviceInfo.service?.service_name ?? null,
          doctorName: doctor?.name ?? null,
          clinicName: clinic?.name ?? null,
          clinicAddress: clinic?.address ?? null,
          message: "Booking created successfully. The clinic will confirm your appointment.",
        });
      },
    }),

    extract_booking_intent: tool({
      description:
        "Extract pre-filled booking slots from a user's free-text message. " +
        "Call this BEFORE search_services whenever the message mentions a service, date, or time. " +
        "Pass only slots you can extract with confidence. Returns a directive telling you which tool to call next.",
      inputSchema: z.object({
        serviceKeyword: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Service the user wants, as a search keyword (e.g. 'gp', 'flu shot', 'house call'). Pass user's exact words; do NOT translate or canonicalize."
          ),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("ISO date YYYY-MM-DD. Resolve relative dates against the Today line in the system prompt."),
        time: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .optional()
          .describe("24h HH:mm. Convert '9am' to '09:00', '3pm' to '15:00'."),
        method: z
          .enum(["in_clinic", "house_call", "video"])
          .optional()
          .describe("Only if the user explicitly mentioned it."),
        isNewPatient: z
          .boolean()
          .optional()
          .describe("Only if the user said 'new patient' / 'first visit' / similar."),
      }),
      execute: async ({ serviceKeyword, date, time, method, isNewPatient }) => {
        const skipReason = evaluateIntentGuard(state, { serviceKeyword, date, time, method, isNewPatient });
        if (skipReason) {
          // Only emit the "you have a booking in progress" directive when the
          // user is actively trying to start a *different* booking. Slot-only
          // stray calls (LLM re-invoking extract on "1"/"yes") and same-
          // service refinements should fall through without derailing the
          // deterministic flow.
          if (
            IN_PROGRESS_BOOKING_REASONS.has(skipReason) &&
            isDifferentServiceKeyword(state, { serviceKeyword, date, time, method, isNewPatient })
          ) {
            return JSON.stringify({
              skipped: true,
              reason: skipReason,
              instruction:
                "A booking is already in progress for this user. Tell the user about their current booking-in-progress (clinic, service, date, time if known) and ask whether they want to continue with that booking or cancel it before starting a new one. Do NOT call search_services, select_clinic, select_service, or any other booking tool yet — wait for the user's reply.",
            });
          }
          return JSON.stringify({ skipped: true, reason: skipReason });
        }

        if (date !== undefined && isPastDate(date)) {
          return JSON.stringify({ error: "date_in_past" });
        }

        const merged: NonNullable<ThreadState["extractedIntent"]> = {
          ...(state.extractedIntent ?? {}),
        };
        if (serviceKeyword !== undefined) merged.serviceKeyword = serviceKeyword;
        if (date !== undefined) merged.date = date;
        if (time !== undefined) merged.time = time;
        if (method !== undefined) merged.method = method;
        if (isNewPatient !== undefined) merged.isNewPatient = isNewPatient;

        await updateState({ extractedIntent: merged });

        // Mid-flow slot refinement (clinic already selected, no service
        // change): the user is correcting time/date on the in-flight booking.
        // Don't re-run search — go straight to availability for the staged or
        // newly-provided date. Treat both "no serviceKeyword provided" and
        // "serviceKeyword equal/overlapping with existing" as refinements.
        const isSlotOnlyRefinement =
          !!state.activeClinicId &&
          !isReentryAttempt(state, { serviceKeyword, date, time, method, isNewPatient }) &&
          (time !== undefined || date !== undefined);

        let nextAction: string | null;
        let nextArgs: Record<string, unknown> | null;
        if (isSlotOnlyRefinement) {
          const dateForAvailability = merged.date ?? state.pendingBookingDate;
          if (dateForAvailability) {
            nextAction = "get_clinic_availability";
            nextArgs = { date: dateForAvailability };
          } else {
            nextAction = null;
            nextArgs = null;
          }
        } else if (merged.serviceKeyword) {
          nextAction = "search_services";
          nextArgs = { query: merged.serviceKeyword };
        } else {
          nextAction = null;
          nextArgs = null;
        }

        return JSON.stringify({
          extracted: merged,
          nextAction,
          nextArgs,
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
            id, original_date, original_time, reschedule_date, reschedule_time, status, remark, address,
            service_info:service_info_id(
              id, price, duration, reminder_remark,
              service:service_id(id, clinic_id, service_name, description),
              doctor:doctor_id(id, name, clinic_id),
              method:method_id(id, method)
            )
          `)
          .eq("wa_user_id", state.userId)
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
          bookings.map((b) => (b.service_info as any)?.service?.clinic_id ?? (b.service_info as any)?.doctor?.clinic_id).filter(Boolean)
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
          const info = b.service_info as any;
          const doctor = info?.doctor;
          const clinicId = info?.service?.clinic_id ?? doctor?.clinic_id;
          return {
            bookingId: b.id,
            date: b.reschedule_date ?? b.original_date,
            time: b.reschedule_time ?? b.original_time,
            status: b.status,
            type: info?.method?.method ?? null,
            service: info?.service,
            doctorName: doctor?.name ?? null,
            clinicName: clinicId ? clinicMap[clinicId] ?? null : null,
            details: b.remark,
            reminderRemark: b.remark,
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
          .select("id, wa_user_id, status, original_date, original_time")
          .eq("id", bookingId)
          .eq("wa_user_id", state.userId)
          .single();

        if (fetchError || !existing) {
          return JSON.stringify({ error: "Booking not found or does not belong to you." });
        }

        if (existing.status === "cancelled" || existing.status === "declined") {
          return JSON.stringify({ error: `Cannot reschedule a ${existing.status} booking.` });
        }

        const updatePayload: Record<string, unknown> = {
          reschedule_date: newDate,
          status: "reschedule_pending",
        };
        if (newTime) {
          updatePayload.reschedule_time = newTime;
        }

        const { error: updateError } = await supabase
          .from("c_s_bookings")
          .update(updatePayload)
          .eq("id", bookingId);

        if (updateError) {
          return JSON.stringify({ error: "Failed to reschedule", detail: updateError.message });
        }

        // Best-effort reminder enqueue. Never blocks user-facing booking confirmation.
        recomputeReminders(bookingId).catch((e) => {
          console.error("[REMINDER] recompute after reschedule failed:", e);
        });

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
          .select("id, wa_user_id, status")
          .eq("id", bookingId)
          .eq("wa_user_id", state.userId)
          .single();

        if (fetchError || !existing) {
          return JSON.stringify({ error: "Booking not found or does not belong to you." });
        }

        if (existing.status === "cancelled") {
          return JSON.stringify({ message: "This booking is already cancelled." });
        }

        const { error: updateError } = await supabase
          .from("c_s_bookings")
          .update({ status: "cancelled" })
          .eq("id", bookingId);

        if (updateError) {
          return JSON.stringify({ error: "Failed to cancel", detail: updateError.message });
        }

        // Recompute (will delete pending jobs since status=cancelled).
        recomputeReminders(bookingId).catch((e) => {
          console.error("[REMINDER] recompute after cancel failed:", e);
        });

        return JSON.stringify({
          success: true,
          bookingId,
          status: "cancelled",
          message: "Booking cancelled successfully.",
        });
      },
    }),

    get_booking_details: tool({
      description: "Get detailed information about a specific booking by its ID.",
      inputSchema: z.object({
        bookingId: z.string().describe("The UUID of the booking to retrieve"),
      }),
      execute: async ({ bookingId }) => {
        if (!state.userId) {
          return JSON.stringify({ error: "Please start a conversation first." });
        }

        const { data: b, error } = await supabase
          .from("c_s_bookings")
          .select(`
            id, original_date, original_time, reschedule_date, reschedule_time, status, remark, address,
            service_info:service_info_id(
              id, price, duration, reminder_remark,
              service:service_id(id, clinic_id, service_name, description),
              doctor:doctor_id(id, name, clinic_id),
              method:method_id(id, method)
            )
          `)
          .eq("id", bookingId)
          .eq("wa_user_id", state.userId)
          .maybeSingle();

        if (error || !b) {
          return JSON.stringify({ error: "Booking not found or does not belong to you." });
        }

        const info = b.service_info as any;
        const doctor = info?.doctor;
        let clinicName = null;
        const clinicId = info?.service?.clinic_id ?? doctor?.clinic_id;
        if (clinicId) {
          const { data: clinic } = await supabase
            .from("c_a_clinics")
            .select("name")
            .eq("id", clinicId)
            .maybeSingle();
          clinicName = clinic?.name ?? null;
        }

        return JSON.stringify({
          bookingId: b.id,
          date: b.reschedule_date ?? b.original_date,
          time: b.reschedule_time ?? b.original_time,
          status: b.status,
          type: info?.method?.method ?? null,
          service: info?.service,
          doctorName: doctor?.name ?? null,
          clinicName,
          details: b.remark,
          address: b.address,
        });
      },
    }),
  };
}
