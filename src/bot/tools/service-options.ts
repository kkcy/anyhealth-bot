import type { MethodOption, ServiceOption } from "@/types";

export type RawServiceRow = {
  id: string;
  service_name: string;
  description: string | null;
  duration_minutes: number;
  price: number | null;
  method_1?: string | null;
  method_2?: string | null;
  method_3?: string | null;
  method_4?: string | null;
  method_5?: string | null;
  method_6?: string | null;
  method_7?: string | null;
  method_8?: string | null;
};

export type MethodMap = Record<string, { id: string; method_name: string; priority: boolean; address: boolean }>;

export function buildServiceOptions(
  services: RawServiceRow[],
  methodMap: MethodMap,
): ServiceOption[] {
  const grouped = new Map<string, RawServiceRow[]>();
  for (const svc of services) {
    const key = normalizeServiceName(svc.service_name);
    grouped.set(key, [...(grouped.get(key) ?? []), svc]);
  }

  return Array.from(grouped.values()).map((group) => {
    const primary = group[0];
    const hasExplicitMethod = group.some((svc) => serviceMethodIds(svc).some((id) => methodMap[id]));
    const hasDefaultVisit = group.some((svc) => serviceMethodIds(svc).length === 0);
    const methods: MethodOption[] = [];
    const seenMethodIds = new Set<string>();

    if (hasDefaultVisit && hasExplicitMethod) {
      methods.push({
        methodName: "In-clinic visit",
        requiresTime: false,
        requiresAddress: false,
      });
    }

    for (const svc of group) {
      for (const mid of serviceMethodIds(svc)) {
        const method = methodMap[mid];
        if (!method || seenMethodIds.has(mid)) continue;
        seenMethodIds.add(mid);
        methods.push({
          methodId: method.id,
          methodName: method.method_name,
          requiresTime: method.priority,
          requiresAddress: method.address,
        });
      }
    }

    return {
      serviceId: primary.id,
      serviceName: primary.service_name,
      description: primary.description ?? "",
      durationMinutes: primary.duration_minutes,
      price: primary.price,
      methods,
    };
  });
}

export function collectMethodIds(services: RawServiceRow[]): string[] {
  return Array.from(new Set(services.flatMap(serviceMethodIds)));
}

function normalizeServiceName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function serviceMethodIds(svc: RawServiceRow): string[] {
  const ids: string[] = [];
  for (let i = 1; i <= 8; i++) {
    const id = svc[`method_${i}` as keyof RawServiceRow];
    if (typeof id === "string" && id.trim()) ids.push(id);
  }
  return ids;
}
