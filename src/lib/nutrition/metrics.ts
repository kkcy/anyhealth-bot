const counters = new Map<string, number>();

export function incrementMetric(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function getMetric(name: string): number {
  return counters.get(name) ?? 0;
}

export function resetMetrics(): void {
  counters.clear();
}
