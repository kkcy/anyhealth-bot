export type SmokeCleanupResult = {
  deletedById: number;
  deletedByMarker: boolean;
  errors: string[];
};

export function createSmokeRunId(caseId: string): string {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${caseId}-${stamp}-${suffix}`;
}

export function smokeTag(runId: string): string {
  return `[smoke-test:${runId}]`;
}

export function appendSmokeTag(remark: string | undefined, runId: string): string {
  const tag = smokeTag(runId);
  const trimmed = remark?.trim();
  return trimmed ? `${trimmed} ${tag}` : tag;
}

export function injectSmokeBookingTag(args: Record<string, unknown>, runId: string): Record<string, unknown> {
  return {
    ...args,
    reminderRemark: appendSmokeTag(
      typeof args.reminderRemark === "string" ? args.reminderRemark : undefined,
      runId
    ),
  };
}

export function collectBookingId(rawResult: unknown, target: string[]): void {
  let parsed: unknown = rawResult;
  if (typeof rawResult === "string") {
    try {
      parsed = JSON.parse(rawResult);
    } catch {
      return;
    }
  }

  if (!parsed || typeof parsed !== "object") return;
  const bookingId = (parsed as { bookingId?: unknown }).bookingId;
  if (typeof bookingId === "string" && bookingId.trim()) {
    target.push(bookingId);
  }
}

export function wrapSmokeBookingTool<T extends Record<string, any>>(
  tools: T,
  runId: string,
  createdBookingIds: string[]
): T {
  const createBooking = tools.create_booking;
  if (!createBooking || typeof createBooking.execute !== "function") return tools;

  return {
    ...tools,
    create_booking: {
      ...createBooking,
      execute: async (args: Record<string, unknown>, options: unknown) => {
        const taggedArgs = injectSmokeBookingTag(args ?? {}, runId);
        const result = await createBooking.execute(taggedArgs, options);
        collectBookingId(result, createdBookingIds);
        return result;
      },
    },
  };
}

export async function cleanupSmokeBookings(
  supabase: {
    from: (table: string) => any;
  },
  runId: string,
  bookingIds: string[]
): Promise<SmokeCleanupResult> {
  const errors: string[] = [];
  const uniqueIds = Array.from(new Set(bookingIds.filter(Boolean)));

  if (uniqueIds.length > 0) {
    const { error } = await supabase.from("c_s_bookings").delete().in("id", uniqueIds);
    if (error) {
      errors.push(`delete by id failed: ${error.message ?? String(error)}`);
    }
  }

  const { error: markerError } = await supabase
    .from("c_s_bookings")
    .delete()
    .ilike("remark", `%${smokeTag(runId)}%`);
  if (markerError) {
    errors.push(`delete by smoke marker failed: ${markerError.message ?? String(markerError)}`);
  }

  return {
    deletedById: uniqueIds.length,
    deletedByMarker: !markerError,
    errors,
  };
}
