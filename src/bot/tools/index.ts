import { createLookupTools } from "./lookup";
import { createBookingTools } from "./booking";
import { createDocumentTools } from "./documents";
import { createInsuranceTools } from "./insurance";
import { manageOptoutsTools } from "./manage-optouts";
import type { ThreadState } from "@/types";

export function createTools(
  state: ThreadState,
  updateState: (partial: Partial<ThreadState>) => Promise<void>
) {
  return {
    ...createLookupTools(state, updateState),
    ...createBookingTools(state, updateState),
    ...createDocumentTools(state, updateState),
    ...createInsuranceTools(state, updateState),
    ...manageOptoutsTools({ state }),
  };
}
