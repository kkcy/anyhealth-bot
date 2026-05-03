import { tool } from "ai";
import { z } from "zod";
import { listMutedClinics, unmuteClinic } from "@/lib/reminders/optout";
import { getSupabase } from "@/lib/supabase";
import type { ThreadState } from "@/types";

interface ToolDeps {
  state: ThreadState;
}

export function manageOptoutsTools({ state }: ToolDeps) {
  return {
    manage_reminder_optouts: tool({
      description:
        "List muted clinics for the current phone and optionally unmute one. " +
        "Call with no args to list. Call with clinicId to unmute a specific clinic.",
      inputSchema: z.object({
        clinicId: z.string().optional().describe("Clinic UUID to unmute. Omit to list."),
      }),
      execute: async ({ clinicId }) => {
        if (!state.phone) {
          return JSON.stringify({ error: "No phone in session." });
        }
        if (clinicId) {
          await unmuteClinic(state.phone, clinicId);
          return JSON.stringify({ success: true, unmutedClinicId: clinicId });
        }
        const ids = await listMutedClinics(state.phone);
        if (ids.length === 0) {
          return JSON.stringify({ muted: [], message: "No clinics currently muted." });
        }
        const sb = getSupabase();
        const { data: clinics } = await sb
          .from("c_a_clinics")
          .select("id, name")
          .in("id", ids);
        return JSON.stringify({
          muted: (clinics ?? []).map((c) => ({ id: c.id, name: c.name })),
        });
      },
    }),
  };
}
