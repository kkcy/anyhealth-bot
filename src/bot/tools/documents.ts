import { tool } from "ai";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import type { ThreadState } from "@/types";

export function createDocumentTools(
  state: ThreadState,
  updateState: (partial: Partial<ThreadState>) => Promise<void>
) {
  const supabase = getSupabase();

  return {
    verify_patient: tool({
      description:
        "Verify a patient's identity using their full name and IC number. " +
        "Required before accessing documents or insurance. Maximum 3 attempts.",
      inputSchema: z.object({
        patientName: z.string().describe("Patient's full name as registered"),
        ic: z.string().describe("Patient's IC or passport number"),
      }),
      execute: async ({ patientName, ic }) => {
        if (state.verifyAttempts >= 3) {
          return JSON.stringify({
            verified: false,
            locked: true,
            message: "Verification locked after 3 failed attempts. Please contact the clinic directly.",
          });
        }

        if (!state.userId) {
          return JSON.stringify({ error: "Please start a conversation first. Call user_lookup." });
        }

        // Search for matching patient linked to this user
        const { data: patients, error } = await supabase
          .from("patient_id")
          .select("id, patient_name, ic_passport")
          .eq("wa_user_id", state.userId);

        if (error) {
          return JSON.stringify({ error: "Failed to verify", detail: error.message });
        }

        // Case-insensitive name match + IC match
        const match = (patients ?? []).find(
          (p) =>
            p.patient_name.toLowerCase().trim() === patientName.toLowerCase().trim() &&
            p.ic_passport?.replace(/[-\s]/g, "") === ic.replace(/[-\s]/g, "")
        );

        if (match) {
          await updateState({
            verified: true,
            activePatientId: match.id,
          });

          return JSON.stringify({
            verified: true,
            patientName: match.patient_name,
            message: "Identity verified successfully.",
          });
        }

        await updateState({
          verifyAttempts: state.verifyAttempts + 1,
        });

        const remaining = 3 - (state.verifyAttempts + 1);
        return JSON.stringify({
          verified: false,
          attemptsRemaining: remaining,
          message:
            remaining > 0
              ? `Name or IC does not match. ${remaining} attempt(s) remaining.`
              : "Verification locked after 3 failed attempts. Please contact the clinic directly.",
        });
      },
    }),

    search_documents: tool({
      description:
        "Search consultation reports and documents for the verified patient. " +
        "Can filter by date range or search by diagnosis description. " +
        "Requires identity verification first.",
      inputSchema: z.object({
        query: z.string().optional().describe("Search by diagnosis or remark text (e.g., 'heart', 'diabetes')"),
        dateFrom: z.string().optional().describe("Start date filter in YYYY-MM-DD format"),
        dateTo: z.string().optional().describe("End date filter in YYYY-MM-DD format"),
      }),
      execute: async ({ query, dateFrom, dateTo }) => {
        // Code guard — verification required
        if (!state.verified) {
          return JSON.stringify({
            error: "Identity verification required. Please provide patient name and IC number.",
          });
        }
        if (state.verifyAttempts >= 3) {
          return JSON.stringify({
            error: "Verification locked. Please contact the clinic directly.",
          });
        }
        if (!state.activePatientId) {
          return JSON.stringify({ error: "No patient selected. Please verify identity first." });
        }

        // Find visits for this patient
        let visitQuery = supabase
          .from("actual_visiting_history")
          .select("id, visit_datetime, provider_cat, doctor_id")
          .eq("patient_id", state.activePatientId)
          .order("visit_datetime", { ascending: false });

        if (dateFrom) {
          visitQuery = visitQuery.gte("visit_datetime", `${dateFrom}T00:00:00`);
        }
        if (dateTo) {
          visitQuery = visitQuery.lte("visit_datetime", `${dateTo}T23:59:59`);
        }

        const { data: visits, error: visitError } = await visitQuery.limit(50);

        if (visitError || !visits || visits.length === 0) {
          return JSON.stringify({ found: false, message: "No consultation records found for this period." });
        }

        const vhIds = visits.map((v) => v.id);

        // Fetch diagnoses for these visits
        let diagQuery = supabase
          .from("actual_diagnosis")
          .select("id, vh_id, diagnosis, remark, created_at")
          .in("vh_id", vhIds);

        if (query) {
          diagQuery = diagQuery.or(`diagnosis.ilike.%${query}%,remark.ilike.%${query}%`);
        }

        const { data: diagnoses } = await diagQuery;

        // Fetch reports with PDF URLs
        const { data: reports } = await supabase
          .from("c_report_consult")
          .select("id, case_id, pdf_url, service_name, time, doctor_id")
          .eq("whatsapp_number", state.phone)
          .eq("is_deleted", false)
          .eq("sent", true)
          .order("time", { ascending: false });

        // Build visit map
        const visitMap = Object.fromEntries(visits.map((v) => [v.id, v]));

        // Combine results
        const results = (diagnoses ?? []).map((d) => {
          const visit = visitMap[d.vh_id];
          const report = (reports ?? []).find((r) => r.case_id === d.vh_id);

          return {
            visitDate: visit?.visit_datetime,
            diagnosis: d.diagnosis,
            remark: d.remark,
            pdfUrl: report?.pdf_url ?? null,
            serviceName: report?.service_name ?? null,
          };
        });

        if (results.length === 0) {
          return JSON.stringify({
            found: false,
            message: query
              ? `No records found matching "${query}" in this period.`
              : "No consultation records found for this period.",
          });
        }

        return JSON.stringify({ found: true, documents: results });
      },
    }),
  };
}
