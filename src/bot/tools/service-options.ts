import type { MethodOption, ServiceOption } from "@/types";

export type ServiceInfoRow = {
  id: string;
  service_id: string;
  price: number | null;
  duration: number | null;
  reminder_remark: string | null;
  service: {
    id: string;
    clinic_id: string;
    service_name: string;
    description: string | null;
  } | null;
  doctor: {
    id: string;
    name: string;
    clinic_id: string;
  } | null;
  method: {
    id: string;
    method: string;
    time_required: number | boolean | null;
    address_required: boolean | null;
  } | null;
};

export function buildServiceOptions(rows: ServiceInfoRow[]): ServiceOption[] {
  const grouped = new Map<string, ServiceInfoRow[]>();
  for (const row of rows) {
    if (!row.service) continue;
    const key = row.service.id;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return Array.from(grouped.values()).map((group) => {
    const primary = group[0];
    const service = primary.service!;
    const methods: MethodOption[] = [];
    const seenMethodIds = new Set<string>();

    for (const row of group) {
      if (!row.method || seenMethodIds.has(row.method.id)) continue;
      seenMethodIds.add(row.method.id);
      methods.push({
        methodId: row.method.id,
        methodName: row.method.method,
        requiresTime: Boolean(row.method.time_required),
        requiresAddress: row.method.address_required === true,
      });
    }

    return {
      serviceId: service.id,
      serviceName: service.service_name,
      description: service.description ?? "",
      durationMinutes: primary.duration ?? 30,
      price: primary.price,
      reminderRemark: primary.reminder_remark ?? undefined,
      methods,
    };
  });
}

export function collectMethodIds(rows: ServiceInfoRow[]): string[] {
  return Array.from(new Set(rows.map((row) => row.method?.id).filter((id): id is string => Boolean(id))));
}
