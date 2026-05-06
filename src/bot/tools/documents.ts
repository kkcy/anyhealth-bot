import { tool } from "ai";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import type { ThreadState } from "@/types";

interface PatientRow {
  id: string;
  patient_name: string;
  ic_passport?: string | null;
}

interface VisitRow {
  id: string;
  patient_id: string;
  visit_datetime: string | null;
  provider_cat: string | null;
  doctor_id: string | null;
}

interface DiagnosisRow {
  id: string;
  vh_id: string;
  diagnosis: string | null;
  remark: string | null;
  created_at: string | null;
}

interface ReportRow {
  id: string;
  case_id: string;
  pdf_url: string | null;
  service_name: string | null;
  time: string | null;
  doctor_id: string | null;
}

interface DocumentItem {
  type: string;
  sourceTable: string;
  visitId: string;
  documentId: string | null;
  url: string | null;
  title: string | null;
}

type GenericDocRow = Record<string, unknown>;

export function createDocumentTools(
  state: ThreadState,
  updateState: (partial: Partial<ThreadState>) => Promise<void>
) {
  const supabase = getSupabase();
  const visitMatchColumns = ["vh_id", "case_id", "visiting_history_id", "visit_id"] as const;

  function asString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return null;
  }

  function looksLikeUrl(value: string): boolean {
    const lower = value.toLowerCase();
    return lower.startsWith("http://") || lower.startsWith("https://") || lower.includes(".pdf");
  }

  function pickDocumentUrl(row: GenericDocRow): string | null {
    const preferredKeys = [
      "pdf_url",
      "file_url",
      "document_url",
      "download_url",
      "attachment_url",
      "storage_url",
      "url",
      "mc_url",
      "invoice_url",
      "referral_url",
    ];

    for (const key of preferredKeys) {
      const value = asString(row[key]);
      if (value && looksLikeUrl(value)) return value;
    }

    for (const rawValue of Object.values(row)) {
      const value = asString(rawValue);
      if (value && looksLikeUrl(value)) return value;
    }

    return null;
  }

  function pickDocumentTitle(row: GenericDocRow): string | null {
    const preferredKeys = [
      "title",
      "name",
      "document_name",
      "mc_no",
      "invoice_no",
      "referral_no",
      "doc_no",
      "number",
      "reference_no",
    ];

    for (const key of preferredKeys) {
      const value = asString(row[key]);
      if (value) return value;
    }
    return null;
  }

  async function fetchTableDocumentsByVisitIds(table: string, visitIds: string[]) {
    let lastError: string | undefined;

    for (const matchColumn of visitMatchColumns) {
      const { data, error } = await supabase
        .from(table)
        .select("*")
        .in(matchColumn, visitIds)
        .limit(200);

      if (!error) {
        return {
          rows: (data ?? []) as GenericDocRow[],
          matchColumn,
          error: undefined as string | undefined,
        };
      }
      lastError = error.message;
    }

    return {
      rows: [] as GenericDocRow[],
      matchColumn: null as string | null,
      error: lastError,
    };
  }

  return {
    start_document_access: tool({
      description:
        "ALWAYS call this FIRST when the user asks for any document (consultation report, MC, invoice, referral) or insurance Q&A. " +
        "It decides whether to show a patient picker (multiple linked patients) or proceed straight to identity verification (one or zero patients). " +
        "Takes no parameters.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!state.userId) {
          return JSON.stringify({ error: "Please call user_lookup first." });
        }
        const patients = state.patients ?? [];
        if (patients.length === 0) {
          return JSON.stringify({
            ready: false,
            noPatients: true,
            instruction:
              "No patient profile is linked to this WhatsApp account yet. Tell the user we don't have any records under their number and ask them to register at the clinic.",
          });
        }
        if (patients.length > 1 && !state.activePatientId) {
          await updateState({ awaitingDocVerification: true });
          return JSON.stringify({
            needsPatientPick: true,
            patients: patients.map((p, i) => ({
              index: i + 1,
              name: p.name,
              ic: p.ic ? p.ic.slice(-4) : "",
            })),
            instruction:
              "The system will render an interactive patient picker. Do NOT list patients in plain text and do NOT ask for the IC yet — wait for the user's tap.",
          });
        }
        return JSON.stringify({
          ready: true,
          instruction:
            "Ask the user for the patient's full name and IC number, then call verify_patient.",
        });
      },
    }),

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
          .from("patient")
          .select("id, patient_name, ic_passport")
          .eq("wa_user_id", state.userId);

        if (error) {
          return JSON.stringify({ error: "Failed to verify", detail: error.message });
        }

        const patientRows = (patients ?? []) as PatientRow[];

        // Case-insensitive name match + IC match
        const match = patientRows.find(
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
        "Search consultation reports and documents for verified users across all linked patients. " +
        "Maps patient_id -> actual_visiting_history.id (vh_id) -> actual_diagnosis and related document tables. " +
        "Can filter by date range or search by diagnosis/remark text. " +
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
        if (!state.userId) {
          return JSON.stringify({ error: "Please start a conversation first. Call user_lookup." });
        }

        // 1) Resolve all patient IDs under this WhatsApp user.
        const { data: linkedPatients, error: linkedPatientError } = await supabase
          .from("patient")
          .select("id, patient_name")
          .eq("wa_user_id", state.userId);
        if (linkedPatientError) {
          return JSON.stringify({ error: "Failed to load linked patients", detail: linkedPatientError.message });
        }

        const patientNameMap: Record<string, string> = {};
        const patientIdSet = new Set<string>();
        for (const p of (linkedPatients ?? []) as Array<{ id: string; patient_name: string }>) {
          patientNameMap[p.id] = p.patient_name;
          patientIdSet.add(p.id);
        }
        for (const p of state.patients ?? []) {
          patientNameMap[p.id] = patientNameMap[p.id] ?? p.name;
          patientIdSet.add(p.id);
        }
        if (state.activePatientId) {
          patientIdSet.add(state.activePatientId);
        }

        const patientIds = Array.from(patientIdSet);
        if (patientIds.length === 0) {
          return JSON.stringify({ found: false, message: "No linked patients found for this account." });
        }

        // 2) Find visits for all linked patients.
        let visitQuery = supabase
          .from("actual_visiting_history")
          .select("id, patient_id, visit_datetime, provider_cat, doctor_id")
          .in("patient_id", patientIds)
          .order("visit_datetime", { ascending: false });

        if (dateFrom) {
          visitQuery = visitQuery.gte("visit_datetime", `${dateFrom}T00:00:00`);
        }
        if (dateTo) {
          visitQuery = visitQuery.lte("visit_datetime", `${dateTo}T23:59:59`);
        }

        const { data: visits, error: visitError } = await visitQuery.limit(100);

        if (visitError || !visits || visits.length === 0) {
          return JSON.stringify({ found: false, message: "No consultation records found for this period." });
        }

        const visitRows = visits as VisitRow[];
        const vhIds = visitRows.map((v) => v.id);

        // 3) Map visiting history IDs to diagnosis rows.
        let diagQuery = supabase
          .from("actual_diagnosis")
          .select("id, vh_id, diagnosis, remark, created_at")
          .in("vh_id", vhIds);

        if (query) {
          diagQuery = diagQuery.or(`diagnosis.ilike.%${query}%,remark.ilike.%${query}%`);
        }

        const { data: diagnoses, error: diagnosisError } = await diagQuery;
        if (diagnosisError) {
          return JSON.stringify({ error: "Failed to load diagnosis records", detail: diagnosisError.message });
        }
        const diagnosisRows = (diagnoses ?? []) as DiagnosisRow[];

        const targetVhIdSet = new Set<string>(
          query
            ? diagnosisRows.map((d) => d.vh_id).filter(Boolean)
            : vhIds
        );

        if (targetVhIdSet.size === 0) {
          return JSON.stringify({
            found: false,
            message: query
              ? `No records found matching "${query}" in this period.`
              : "No consultation records found for this period.",
          });
        }

        const targetVhIds = Array.from(targetVhIdSet);

        // 4) Fetch all related documents by same visit IDs.
        const { data: reports, error: reportError } = await supabase
          .from("c_report_consult")
          .select("id, case_id, pdf_url, service_name, time, doctor_id")
          .in("case_id", targetVhIds)
          .eq("is_deleted", false)
          .eq("sent", true)
          .order("time", { ascending: false });
        if (reportError) {
          return JSON.stringify({ error: "Failed to load consultation reports", detail: reportError.message });
        }
        const reportRows = (reports ?? []) as ReportRow[];

        const [mcDocs, invoiceDocs, referralDocs] = await Promise.all([
          fetchTableDocumentsByVisitIds("actual_mc", targetVhIds),
          fetchTableDocumentsByVisitIds("actual_invoice", targetVhIds),
          fetchTableDocumentsByVisitIds("actual_referral", targetVhIds),
        ]);

        const warningDetails = [
          mcDocs.error ? `actual_mc: ${mcDocs.error}` : null,
          invoiceDocs.error ? `actual_invoice: ${invoiceDocs.error}` : null,
          referralDocs.error ? `actual_referral: ${referralDocs.error}` : null,
        ].filter(Boolean) as string[];

        const diagnosisByVisit: Record<string, DiagnosisRow[]> = {};
        for (const d of diagnosisRows) {
          if (!diagnosisByVisit[d.vh_id]) diagnosisByVisit[d.vh_id] = [];
          diagnosisByVisit[d.vh_id].push(d);
        }

        const reportByVisit: Record<string, ReportRow[]> = {};
        for (const r of reportRows) {
          if (!reportByVisit[r.case_id]) reportByVisit[r.case_id] = [];
          reportByVisit[r.case_id].push(r);
        }

        const docsByVisit: Record<string, DocumentItem[]> = {};
        const pushDoc = (doc: DocumentItem) => {
          if (!docsByVisit[doc.visitId]) docsByVisit[doc.visitId] = [];
          docsByVisit[doc.visitId].push(doc);
        };

        for (const r of reportRows) {
          pushDoc({
            type: "consult_report",
            sourceTable: "c_report_consult",
            visitId: r.case_id,
            documentId: r.id,
            url: r.pdf_url ?? null,
            title: r.service_name ?? "Consultation Report",
          });
        }

        const appendGenericDocs = (
          tableName: "actual_mc" | "actual_invoice" | "actual_referral",
          docs: { rows: GenericDocRow[]; matchColumn: string | null }
        ) => {
          if (!docs.matchColumn) return;

          const typeMap: Record<typeof tableName, string> = {
            actual_mc: "mc",
            actual_invoice: "invoice",
            actual_referral: "referral",
          };

          for (const row of docs.rows) {
            const visitId = asString(row[docs.matchColumn]);
            if (!visitId || !targetVhIdSet.has(visitId)) continue;
            pushDoc({
              type: typeMap[tableName],
              sourceTable: tableName,
              visitId,
              documentId: asString(row.id),
              url: pickDocumentUrl(row),
              title: pickDocumentTitle(row),
            });
          }
        };

        appendGenericDocs("actual_mc", mcDocs);
        appendGenericDocs("actual_invoice", invoiceDocs);
        appendGenericDocs("actual_referral", referralDocs);

        // 5) Build user-facing result grouped by visit.
        const targetVisits = visitRows.filter((v) => targetVhIdSet.has(v.id));
        const results = targetVisits.map((visit) => {
          const diagnosesForVisit = diagnosisByVisit[visit.id] ?? [];
          const firstDiag = diagnosesForVisit[0];
          const firstReport = (reportByVisit[visit.id] ?? [])[0];

          return {
            patientId: visit.patient_id,
            patientName: patientNameMap[visit.patient_id] ?? null,
            visitId: visit.id,
            visitDate: visit.visit_datetime,
            diagnosis: firstDiag?.diagnosis ?? null,
            remark: firstDiag?.remark ?? null,
            diagnoses: diagnosesForVisit.map((d) => ({
              diagnosis: d.diagnosis,
              remark: d.remark,
              createdAt: d.created_at,
            })),
            pdfUrl: firstReport?.pdf_url ?? null,
            serviceName: firstReport?.service_name ?? null,
            documents: docsByVisit[visit.id] ?? [],
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

        return JSON.stringify({
          found: true,
          patientCount: patientIds.length,
          visitCount: targetVisits.length,
          documents: results,
          warnings: warningDetails.length > 0 ? warningDetails : undefined,
        });
      },
    }),
  };
}
