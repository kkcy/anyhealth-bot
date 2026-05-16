import { tool } from "ai";
import { z } from "zod";
import { listMutedClinics, unmuteClinic } from "@/lib/reminders/optout";
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
        const cached = state.clinicOptions ?? [];
        const byId = new Map(cached.map((c) => [c.clinicId, c.clinicName]));
        return JSON.stringify({
          muted: ids.map((id) => ({ id, name: byId.get(id) ?? null })),
        });
      },
    }),
  };
}
