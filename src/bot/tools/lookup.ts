import { tool } from "ai";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import type { ThreadState } from "@/types";

export function createLookupTools(
  state: ThreadState,
  updateState: (partial: Partial<ThreadState>) => Promise<void>
) {
  const supabase = getSupabase();

  return {
    user_lookup: tool({
      description:
        "Look up the current user by their WhatsApp phone number. " +
        "Call this first at the start of every conversation. Takes no parameters.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!state.phone) {
          return "Could not determine sender identity. WhatsApp is required.";
        }

        // Find whatsapp_users by phone
        const { data: user, error: userError } = await supabase
          .from("whatsapp_users")
          .select("id, user_name, whatsapp_number, language")
          .or(`whatsapp_number.eq.${state.phone},whatsapp_number.eq.+${state.phone}`)
          .limit(1)
          .maybeSingle();

        if (userError) {
          return JSON.stringify({ error: "Failed to look up user", detail: userError.message });
        }

        if (!user) {
          return JSON.stringify({
            found: false,
            message: "No account found for this phone number. Please register at a clinic first.",
          });
        }

        // Find all patients linked to this user
        const { data: patients, error: patientError } = await supabase
          .from("patient_id")
          .select("id, patient_name, ic_passport")
          .eq("wa_user_id", user.id);

        if (patientError) {
          return JSON.stringify({ error: "Failed to load patients", detail: patientError.message });
        }

        const patientRefs = (patients ?? []).map((p) => ({
          id: p.id,
          name: p.patient_name,
          ic: p.ic_passport ?? "",
        }));

        await updateState({
          userId: user.id,
          patients: patientRefs,
          activePatientId: patientRefs.length === 1 ? patientRefs[0].id : undefined,
          language: user.language ?? undefined,
        });

        return JSON.stringify({
          found: true,
          userName: user.user_name,
          language: user.language,
          patients: patientRefs.map((p) => ({ id: p.id, name: p.name, ic: p.ic.slice(-4) })),
          patientCount: patientRefs.length,
        });
      },
    }),

    select_patient: tool({
      description:
        "Select which patient to act on behalf of. " +
        "Use this when user_lookup returned multiple patients and the user has indicated which one. " +
        "The patientId must be one of the IDs returned by user_lookup.",
      inputSchema: z.object({
        patientId: z.string().uuid().describe("Patient ID from user_lookup results"),
      }),
      execute: async ({ patientId }) => {
        const patient = state.patients?.find((p) => p.id === patientId);
        if (!patient) {
          return JSON.stringify({
            error: "Patient not found. Use an ID returned by user_lookup.",
            availablePatients: state.patients?.map((p) => ({ id: p.id, name: p.name })) ?? [],
          });
        }

        await updateState({ activePatientId: patientId });

        return JSON.stringify({
          success: true,
          patientId: patient.id,
          patientName: patient.name,
          message: `Now acting on behalf of ${patient.name}.`,
        });
      },
    }),

    search_services: tool({
      description:
        "Search for clinic services by name, description, or category. " +
        "Returns matching services with clinic ID, service details, and available methods (may be empty). " +
        "Use short, simple keywords (e.g. 'heart' or 'checkup', not full sentences). " +
        "If no results, try a different keyword once — do not repeat the same query.",
      inputSchema: z.object({
        query: z.string().describe("Service name, description, or category to search for"),
      }),
      execute: async ({ query }) => {
        // Split query into individual words for broader matching
        const words = query
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 1);

        // Build OR conditions for each word across name, description, category
        const orConditions = words
          .flatMap((word) => [
            `service_name.ilike.%${word}%`,
            `description.ilike.%${word}%`,
            `category.ilike.%${word}%`,
          ])
          .join(",");

        // Search in Clinic services
        const { data: cServices, error: cError } = await supabase
          .from("c_a_clinic_service")
          .select(`
            id, service_name, description, category, duration_minutes, price,
            method_1, method_2, method_3, method_4, method_5, method_6, method_7, method_8,
            clinic_id
          `)
          .eq("is_active", true)
          .or(orConditions)
          .limit(10);

        // Search in TCM services
        const { data: tcmServices, error: tcmError } = await supabase
          .from("tcm_a_clinic_service")
          .select(`
            id, service_name, description, category, duration_minutes, price,
            method_1, method_2, method_3, method_4, method_5, method_6, method_7, method_8,
            clinic_id
          `)
          .eq("is_active", true)
          .or(orConditions)
          .limit(10);

        if (cError || tcmError) {
          return JSON.stringify({ error: "Failed to search services", detail: cError?.message || tcmError?.message });
        }

        const allServices = [...(cServices ?? []), ...(tcmServices ?? [])];

        if (allServices.length === 0) {
          return JSON.stringify({ found: false, message: "No services found matching your description." });
        }

        // Collect all method IDs from results
        const methodIds = new Set<string>();
        for (const svc of allServices) {
          for (let i = 1; i <= 8; i++) {
            const mid = (svc as any)[`method_${i}`] as string | null;
            if (mid) methodIds.add(mid);
          }
        }

        // Fetch method details (TCM and Clinic methods are in the same table c_a_service_method)
        let methodMap: Record<string, { id: string; method_name: string; priority: boolean; address: boolean }> = {};
        if (methodIds.size > 0) {
          const { data: methods } = await supabase
            .from("c_a_service_method")
            .select("id, method_name, priority, address")
            .in("id", Array.from(methodIds));

          if (methods) {
            methodMap = Object.fromEntries(methods.map((m) => [m.id, m]));
          }
        }

        // Format results
        const results = allServices.map((svc) => {
          const methods = [];
          for (let i = 1; i <= 8; i++) {
            const mid = (svc as any)[`method_${i}`] as string | null;
            if (mid && methodMap[mid]) {
              methods.push(methodMap[mid]);
            }
          }

          return {
            serviceId: svc.id,
            name: svc.service_name,
            description: svc.description,
            category: svc.category,
            durationMinutes: svc.duration_minutes,
            price: svc.price,
            clinicId: svc.clinic_id,
            methods: methods.map((m) => ({
              methodId: m.id,
              name: m.method_name,
              requiresTime: m.priority,
              requiresAddress: m.address,
            })),
          };
        });

        return JSON.stringify({ found: true, services: results });
      },
    }),

    get_clinic_doctors: tool({
      description:
        "Get doctors for a specific clinic. Returns doctor ID and name only. " +
        "Call this after the user selects a clinic from search_services results.",
      inputSchema: z.object({
        clinicId: z.string().uuid().describe("Clinic ID from search_services results"),
      }),
      execute: async ({ clinicId }) => {
        const { data: doctors, error } = await supabase
          .from("c_a_doctors")
          .select("id, name")
          .eq("clinic_id", clinicId);

        if (error) {
          return JSON.stringify({ error: "Failed to load doctors", detail: error.message });
        }

        if (!doctors || doctors.length === 0) {
          return JSON.stringify({ found: false, message: "No doctors found for this clinic." });
        }

        return JSON.stringify({
          found: true,
          doctors: doctors.map((d) => ({
            doctorId: d.id,
            name: d.name,
          })),
        });
      },
    }),

    get_clinic_availability: tool({
      description:
        "Check clinic opening hours for a given day. " +
        "Returns operating hours, lunch breaks, and already-booked time slots (NOT available slots — you must calculate free times from the gaps).",
      inputSchema: z.object({
        clinicId: z.string().uuid().describe("The clinic ID"),
        date: z.string().describe("Date to check in YYYY-MM-DD format"),
        doctorId: z.string().uuid().optional().describe("Optional doctor ID to check their bookings"),
      }),
      execute: async ({ clinicId, date, doctorId }) => {
        // Get clinic hours
        const { data: hours, error: hoursError } = await supabase
          .from("c_a_clinic_available_time")
          .select("*")
          .eq("clinic_id", clinicId)
          .limit(1)
          .maybeSingle();

        if (hoursError || !hours) {
          return JSON.stringify({ error: "Could not find clinic hours" });
        }

        // Determine day of week
        const dayOfWeek = new Date(date).toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();

        const dayStart = hours[`${dayOfWeek}_start` as keyof typeof hours];
        const dayEnd = hours[`${dayOfWeek}_end` as keyof typeof hours];
        const lunchStart = hours[`${dayOfWeek}_lunch_start` as keyof typeof hours];
        const lunchEnd = hours[`${dayOfWeek}_lunch_end` as keyof typeof hours];

        if (!dayStart || !dayEnd) {
          return JSON.stringify({ open: false, message: `Clinic is closed on ${dayOfWeek}s.` });
        }

        // Check for self-declared holidays
        const holidays: string[] = hours.holiday_self_declared ?? [];
        if (holidays.includes(date)) {
          return JSON.stringify({ open: false, message: "Clinic is closed on this date (holiday)." });
        }

        // Get existing bookings for the date
        let bookingQuery = supabase
          .from("c_s_bookings")
          .select("id, original_time, new_time, status, duration_minutes")
          .or(`original_date.eq.${date},new_date.eq.${date}`)
          .not("status", "in", "(cancelled,declined)");

        if (doctorId) {
          bookingQuery = bookingQuery.eq("doctor_id", doctorId);
        }

        const { data: bookings } = await bookingQuery;

        const bookedTimes = (bookings ?? []).map((b) => ({
          time: b.new_time ?? b.original_time,
          duration: b.duration_minutes,
        }));

        return JSON.stringify({
          open: true,
          dayOfWeek,
          hours: { start: dayStart, end: dayEnd },
          lunch: lunchStart && lunchEnd ? { start: lunchStart, end: lunchEnd } : null,
          bookedSlots: bookedTimes,
        });
      },
    }),
  };
}
