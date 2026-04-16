import { tool } from "ai";
import { z } from "zod";
import { generateText } from "@/lib/config";
import { getSupabase } from "@/lib/supabase";
import { extractTextFromPdf, downloadFile } from "@/lib/pdf";
import type { ThreadState } from "@/types";

export function createInsuranceTools(
  state: ThreadState,
  updateState: (partial: Partial<ThreadState>) => Promise<void>
) {
  const supabase = getSupabase();

  return {
    upload_insurance: tool({
      description:
        "Upload and process an insurance policy PDF for a patient. " +
        "Call this when the user sends a document/PDF file. " +
        "Requires identity verification first.",
      inputSchema: z.object({
        fileUrl: z.string().url().describe("URL of the uploaded PDF file from WhatsApp"),
        insurerName: z.string().optional().describe("Name of the insurance company if mentioned"),
        policyNumber: z.string().optional().describe("Policy number if mentioned"),
      }),
      execute: async ({ fileUrl, insurerName, policyNumber }) => {
        // Code guard
        if (!state.verified) {
          return JSON.stringify({
            error: "Identity verification required before uploading insurance documents.",
          });
        }
        if (!state.activePatientId) {
          return JSON.stringify({ error: "No patient selected. Please verify identity first." });
        }

        try {
          // Download and extract PDF text
          const pdfBuffer = await downloadFile(fileUrl);
          const rawText = await extractTextFromPdf(pdfBuffer);

          if (!rawText || rawText.trim().length < 50) {
            return JSON.stringify({
              error: "Could not extract text from this PDF. It may be a scanned image. Please try uploading a text-based PDF.",
            });
          }

          // Store in Supabase storage
          const fileName = `insurance/${state.activePatientId}/${Date.now()}.pdf`;
          const { data: uploadData, error: uploadError } = await supabase.storage
            .from("documents")
            .upload(fileName, pdfBuffer, { contentType: "application/pdf" });

          const storedUrl = uploadData?.path
            ? supabase.storage.from("documents").getPublicUrl(uploadData.path).data.publicUrl
            : fileUrl;

          // Insert into patient_insurance
          const { data: insurance, error } = await supabase
            .from("patient_insurance")
            .insert({
              patient_id: state.activePatientId,
              insurer_name: insurerName || null,
              policy_number: policyNumber || null,
              raw_text: rawText,
              file_url: storedUrl,
            })
            .select("id, insurer_name")
            .single();

          if (error) {
            return JSON.stringify({ error: "Failed to save insurance policy", detail: error.message });
          }

          await updateState({ activeInsuranceId: insurance.id });

          return JSON.stringify({
            success: true,
            insuranceId: insurance.id,
            insurerName: insurance.insurer_name,
            textLength: rawText.length,
            message: "Insurance policy saved successfully. You can now ask questions about this policy.",
          });
        } catch (err) {
          return JSON.stringify({
            error: "Failed to process PDF",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      },
    }),

    list_insurance: tool({
      description:
        "List all insurance policies stored for the current patient. " +
        "Requires identity verification.",
      inputSchema: z.object({}),
      execute: async () => {
        // Code guard
        if (!state.verified) {
          return JSON.stringify({
            error: "Identity verification required.",
          });
        }
        if (!state.activePatientId) {
          return JSON.stringify({ error: "No patient selected." });
        }

        const { data: policies, error } = await supabase
          .from("patient_insurance")
          .select("id, insurer_name, policy_number, created_at")
          .eq("patient_id", state.activePatientId)
          .order("created_at", { ascending: false });

        if (error) {
          return JSON.stringify({ error: "Failed to load policies", detail: error.message });
        }

        if (!policies || policies.length === 0) {
          return JSON.stringify({
            found: false,
            message: "No insurance policies on file. You can upload a policy PDF to get started.",
          });
        }

        return JSON.stringify({
          found: true,
          policies: policies.map((p) => ({
            insuranceId: p.id,
            insurerName: p.insurer_name ?? "Unknown insurer",
            policyNumber: p.policy_number ?? "N/A",
            uploadedAt: p.created_at,
          })),
        });
      },
    }),

    ask_insurance: tool({
      description:
        "Ask a question about an insurance policy. Uses the full policy text to answer. " +
        "If the information is not in the policy, responds with 'not mentioned'. " +
        "Requires identity verification.",
      inputSchema: z.object({
        question: z.string().describe("The insurance question to answer"),
        insuranceId: z.string().optional().describe("Exact policy UUID from list_insurance results. Uses most recent if not specified."),
      }),
      execute: async ({ question, insuranceId }) => {
        // Code guard
        if (!state.verified) {
          return JSON.stringify({
            error: "Identity verification required.",
          });
        }
        if (!state.activePatientId) {
          return JSON.stringify({ error: "No patient selected." });
        }

        // Load policy text
        let query = supabase
          .from("patient_insurance")
          .select("id, insurer_name, policy_number, raw_text")
          .eq("patient_id", state.activePatientId);

        if (insuranceId) {
          query = query.eq("id", insuranceId);
        } else if (state.activeInsuranceId) {
          query = query.eq("id", state.activeInsuranceId);
        } else {
          query = query.order("created_at", { ascending: false }).limit(1);
        }

        const { data: policies, error } = await query;

        if (error || !policies || policies.length === 0) {
          return JSON.stringify({
            error: "No insurance policy found. Please upload a policy PDF first.",
          });
        }

        const policy = policies[0];

        if (!policy.raw_text || policy.raw_text.trim().length < 50) {
          return JSON.stringify({
            error: "Policy text is empty or too short. The PDF may not have been processed correctly.",
          });
        }

        // Nested LLM call with full policy text as context
        try {
          const result = await generateText({
            maxOutputTokens: 1024,
            system: `You are an insurance policy reader. Answer the user's question based ONLY on the policy text provided below. If the information is not mentioned in the policy, respond with: "This is not mentioned in your policy." Do not guess, infer, or provide information not explicitly stated in the policy text.

INSURANCE POLICY TEXT:
---
${policy.raw_text}
---

Policy: ${policy.insurer_name ?? "Unknown"} (${policy.policy_number ?? "N/A"})`,
            messages: [{ role: "user", content: question }],
          });

          return JSON.stringify({
            answer: result.text,
            policyName: policy.insurer_name,
            policyNumber: policy.policy_number,
          });
        } catch (err) {
          return JSON.stringify({
            error: "Failed to analyze policy",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      },
    }),
  };
}
