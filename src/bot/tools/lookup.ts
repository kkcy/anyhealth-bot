import { tool } from "ai";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import type { ThreadState, ServiceOption, MethodOption, DoctorOption } from "@/types";

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
          patients: patientRefs.map((p, i) => ({ index: i + 1, name: p.name, ic: p.ic.slice(-4) })),
          patientCount: patientRefs.length,
        });
      },
    }),

    select_patient: tool({
      description:
        "Select which patient to act on behalf of. " +
        "Use when user_lookup returned multiple patients and the user indicated which one.",
      inputSchema: z.object({
        index: z.number().describe("Patient number from user_lookup list (1, 2, 3, ...)"),
      }),
      execute: async ({ index }) => {
        const patients = state.patients ?? [];
        if (index < 1 || index > patients.length) {
          return JSON.stringify({
            error: `Invalid selection. Choose a number between 1 and ${patients.length}.`,
            patients: patients.map((p, i) => ({ index: i + 1, name: p.name })),
          });
        }

        const patient = patients[index - 1];
        await updateState({ activePatientId: patient.id });

        return JSON.stringify({
          success: true,
          patientName: patient.name,
          message: `Now acting on behalf of ${patient.name}.`,
        });
      },
    }),

    search_services: tool({
      description:
        "Search for clinic services by keyword. Returns a numbered list. " +
        "After presenting results to the user, call select_service with their choice. " +
        "Use short keywords (e.g. 'heart' or 'checkup', not full sentences). " +
        "If no results, try a different keyword once — do not repeat the same query.",
      inputSchema: z.object({
        query: z.string().describe("Service name, description, or category to search for"),
      }),
      execute: async ({ query }) => {
        const words = query
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 1);

        const orConditions = words
          .flatMap((word) => [
            `service_name.ilike.%${word}%`,
            `description.ilike.%${word}%`,
            `category.ilike.%${word}%`,
          ])
          .join(",");

        const { data: cServices, error: cError } = await supabase
          .from("c_a_clinic_service")
          .select(`
            id, service_name, description, category, duration_minutes, price,
            method_1, method_2, method_3, method_4, method_5, method_6, method_7, method_8,
            clinic_id
          `)
          .eq("is_active", true)
          .or(orConditions)
          .limit(30);

        const { data: tcmServices, error: tcmError } = await supabase
          .from("tcm_a_clinic_service")
          .select(`
            id, service_name, description, category, duration_minutes, price,
            method_1, method_2, method_3, method_4, method_5, method_6, method_7, method_8,
            clinic_id
          `)
          .eq("is_active", true)
          .or(orConditions)
          .limit(30);

        if (cError || tcmError) {
          return JSON.stringify({ error: "Failed to search services", detail: cError?.message || tcmError?.message });
        }

        // Require ALL words to match somewhere in the service (name, description, or category)
        const rawServices = [...(cServices ?? []), ...(tcmServices ?? [])];
        const allServices = rawServices.filter((svc) => {
          const text = `${svc.service_name} ${svc.description ?? ""} ${svc.category ?? ""}`.toLowerCase();
          return words.every((w) => text.includes(w));
        }).slice(0, 10);

        if (allServices.length === 0) {
          return JSON.stringify({ found: false, message: "No services found matching your description." });
        }

        // Fetch clinic details
        const clinicIds = [...new Set(allServices.map((s) => s.clinic_id))];
        let clinicMap: Record<string, { name: string; address: string; doctor_selection: boolean | null }> = {};
        if (clinicIds.length > 0) {
          const { data: clinics } = await supabase
            .from("c_a_clinics")
            .select("id, name, address, doctor_selection")
            .in("id", clinicIds);
          if (clinics) {
            clinicMap = Object.fromEntries(clinics.map((c) => [c.id, c]));
          }
        }

        // Fetch method details
        const methodIds = new Set<string>();
        for (const svc of allServices) {
          for (let i = 1; i <= 8; i++) {
            const mid = (svc as any)[`method_${i}`] as string | null;
            if (mid) methodIds.add(mid);
          }
        }

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

        // Build options and save to state
        const serviceOptions: ServiceOption[] = allServices.map((svc) => {
          const svcMethods: MethodOption[] = [];
          for (let i = 1; i <= 8; i++) {
            const mid = (svc as any)[`method_${i}`] as string | null;
            if (mid && methodMap[mid]) {
              const m = methodMap[mid];
              svcMethods.push({
                methodId: m.id,
                methodName: m.method_name,
                requiresTime: m.priority,
                requiresAddress: m.address,
              });
            }
          }

          const clinic = clinicMap[svc.clinic_id];
          return {
            serviceId: svc.id,
            serviceName: svc.service_name,
            clinicId: svc.clinic_id,
            clinicName: clinic?.name ?? "Unknown clinic",
            clinicAddress: clinic?.address ?? "",
            doctorSelection: clinic?.doctor_selection ?? true,
            methods: svcMethods,
          };
        });

        await updateState({ serviceOptions });

        // Return numbered list for the LLM to present
        const display = serviceOptions.map((opt, i) => ({
          index: i + 1,
          service: opt.serviceName,
          clinic: opt.clinicName,
          address: opt.clinicAddress,
          methods: opt.methods.length > 0
            ? opt.methods.map((m) => m.methodName)
            : ["In-clinic visit"],
        }));

        return JSON.stringify({
          found: true,
          count: display.length,
          services: display,
          instruction: "Present these options to the user. When they choose, call select_service with the index number.",
        });
      },
    }),

    select_service: tool({
      description:
        "Select a service from search_services results by index number. " +
        "If the service has multiple methods, also pass the method index. " +
        "If only one method, it is auto-selected.",
      inputSchema: z.object({
        index: z.number().describe("Service number from search_services list (1, 2, 3, ...)"),
        methodIndex: z.number().optional().describe("Method number if the service has multiple methods (1, 2, ...)"),
      }),
      execute: async ({ index, methodIndex }) => {
        const options = state.serviceOptions ?? [];
        if (index < 1 || index > options.length) {
          return JSON.stringify({
            error: `Invalid selection. Choose a number between 1 and ${options.length}.`,
          });
        }

        const service = options[index - 1];
        let selectedMethodId: string | undefined;
        let selectedMethod: MethodOption | undefined;

        if (service.methods.length === 0) {
          // No selectable methods
        } else if (service.methods.length === 1) {
          // Auto-select the only method
          selectedMethod = service.methods[0];
          selectedMethodId = selectedMethod.methodId;
        } else if (methodIndex !== undefined) {
          if (methodIndex < 1 || methodIndex > service.methods.length) {
            return JSON.stringify({
              error: `Invalid method. Choose between 1 and ${service.methods.length}.`,
              methods: service.methods.map((m, i) => ({ index: i + 1, name: m.methodName })),
            });
          }
          selectedMethod = service.methods[methodIndex - 1];
          selectedMethodId = selectedMethod.methodId;
        } else {
          // Multiple methods, none selected — ask user to choose
          return JSON.stringify({
            needsMethodSelection: true,
            service: service.serviceName,
            clinic: service.clinicName,
            methods: service.methods.map((m, i) => ({
              index: i + 1,
              name: m.methodName,
              requiresTime: m.requiresTime,
              requiresAddress: m.requiresAddress,
            })),
            instruction: "Ask the user which method they prefer, then call select_service again with the methodIndex.",
          });
        }

        await updateState({
          activeServiceId: service.serviceId,
          activeClinicId: service.clinicId,
          activeMethodId: selectedMethodId,
        });

        // Determine next step
        const needsDoctors = service.doctorSelection;

        return JSON.stringify({
          success: true,
          service: service.serviceName,
          clinic: service.clinicName,
          clinicAddress: service.clinicAddress,
          method: selectedMethod?.methodName ?? "In-clinic visit",
          requiresTime: selectedMethod?.requiresTime ?? false,
          requiresAddress: selectedMethod?.requiresAddress ?? false,
          nextStep: needsDoctors
            ? "Call get_clinic_doctors to let the user pick a doctor."
            : "Clinic assigns doctors. Proceed to ask for date/time.",
        });
      },
    }),

    get_clinic_doctors: tool({
      description:
        "Get doctors for the selected clinic. Call after select_service. " +
        "Takes no parameters — reads the clinic from the current selection. " +
        "If only one doctor, they are auto-selected.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!state.activeClinicId) {
          return JSON.stringify({ error: "No clinic selected. Call select_service first." });
        }

        const { data: doctors, error } = await supabase
          .from("c_a_doctors")
          .select("id, name")
          .eq("clinic_id", state.activeClinicId);

        if (error) {
          return JSON.stringify({ error: "Failed to load doctors", detail: error.message });
        }

        if (!doctors || doctors.length === 0) {
          return JSON.stringify({ found: false, message: "No doctors found for this clinic." });
        }

        // Auto-select if only one doctor
        if (doctors.length === 1) {
          await updateState({
            activeDoctorId: doctors[0].id,
            doctorOptions: [{ doctorId: doctors[0].id, name: doctors[0].name }],
          });
          return JSON.stringify({
            found: true,
            autoSelected: true,
            doctorName: doctors[0].name,
            message: `Dr. ${doctors[0].name} is the doctor at this clinic.`,
            nextStep: "Proceed to ask for date/time.",
          });
        }

        const doctorOptions: DoctorOption[] = doctors.map((d) => ({
          doctorId: d.id,
          name: d.name,
        }));

        await updateState({ doctorOptions });

        return JSON.stringify({
          found: true,
          doctors: doctorOptions.map((d, i) => ({ index: i + 1, name: d.name })),
          instruction: "Present the doctors to the user. When they choose, call select_doctor with the index number.",
        });
      },
    }),

    select_doctor: tool({
      description:
        "Select a doctor by index number from get_clinic_doctors results.",
      inputSchema: z.object({
        index: z.number().describe("Doctor number from get_clinic_doctors list (1, 2, 3, ...)"),
      }),
      execute: async ({ index }) => {
        const options = state.doctorOptions ?? [];
        if (index < 1 || index > options.length) {
          return JSON.stringify({
            error: `Invalid selection. Choose a number between 1 and ${options.length}.`,
          });
        }

        const doctor = options[index - 1];
        await updateState({ activeDoctorId: doctor.doctorId });

        return JSON.stringify({
          success: true,
          doctorName: doctor.name,
          nextStep: "Proceed to ask for date/time.",
        });
      },
    }),

    get_clinic_availability: tool({
      description:
        "Check clinic opening hours for a given day. Reads the clinic from current selection. " +
        "Returns operating hours, lunch breaks, and booked slots. You must calculate free times from gaps.",
      inputSchema: z.object({
        date: z.string().describe("Date to check in YYYY-MM-DD format"),
      }),
      execute: async ({ date }) => {
        const clinicId = state.activeClinicId;
        if (!clinicId) {
          return JSON.stringify({ error: "No clinic selected. Call select_service first." });
        }

        const { data: hours, error: hoursError } = await supabase
          .from("c_a_clinic_available_time")
          .select("*")
          .eq("clinic_id", clinicId)
          .limit(1)
          .maybeSingle();

        if (hoursError || !hours) {
          return JSON.stringify({ error: "Could not find clinic hours" });
        }

        const dayOfWeek = new Date(date).toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();

        const dayStart = hours[`${dayOfWeek}_start` as keyof typeof hours];
        const dayEnd = hours[`${dayOfWeek}_end` as keyof typeof hours];
        const lunchStart = hours[`${dayOfWeek}_lunch_start` as keyof typeof hours];
        const lunchEnd = hours[`${dayOfWeek}_lunch_end` as keyof typeof hours];

        if (!dayStart || !dayEnd) {
          return JSON.stringify({ open: false, message: `Clinic is closed on ${dayOfWeek}s.` });
        }

        const holidays: string[] = hours.holiday_self_declared ?? [];
        if (holidays.includes(date)) {
          return JSON.stringify({ open: false, message: "Clinic is closed on this date (holiday)." });
        }

        let bookingQuery = supabase
          .from("c_s_bookings")
          .select("id, original_time, new_time, status, duration_minutes")
          .or(`original_date.eq.${date},new_date.eq.${date}`)
          .not("status", "in", "(cancelled,declined)");

        if (state.activeDoctorId) {
          bookingQuery = bookingQuery.eq("doctor_id", state.activeDoctorId);
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
