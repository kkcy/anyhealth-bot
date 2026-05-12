import { tool } from "ai";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import { GoogleAuth } from "google-auth-library";
import type { ThreadState, ClinicOption, ServiceOption, MethodOption, DoctorOption } from "@/types";
import { haversineKm } from "@/lib/geo";
import { buildServiceOptions, type ServiceInfoRow } from "./service-options";
import { canonicalPhoneForInsert, chooseWaUserCandidate, phoneLookupVariants } from "../phone-user";

type ServiceCatalogRow = {
  id: string;
  clinic_id: string;
  service_name: string | null;
  description: string | null;
};

type RankedServiceMatch = {
  row: ServiceCatalogRow;
  score: number;
  matchedTerms: string[];
};

type CachedSearchResult = {
  clinicOptions: ClinicOption[];
  topServiceCandidates: Array<{ name: string; clinicId: string }>;
  matchConfidence: "high" | "medium" | "low";
  rerankSource: "vertex-ranking-api" | "heuristic";
  cachedAt: number;
};

type LookupPatientRow = {
  id: string;
  patient_name: string;
  ic_passport?: string | null;
  wa_user_id?: string | null;
};

const SEARCH_CACHE_TTL_MS = Number(process.env.SERVICE_SEARCH_CACHE_TTL_MS ?? 12 * 60 * 60 * 1000);
const SEARCH_CACHE_MAX_ITEMS = Number(process.env.SERVICE_SEARCH_CACHE_MAX_ITEMS ?? 500);
const serviceSearchCache = new Map<string, CachedSearchResult>();

const TERM_SYNONYMS: Record<string, string[]> = {
  fever: ["consultation", "general consultation", "doctor consult"],
  cough: ["consultation", "general consultation"],
  flu: ["consultation", "general consultation", "influenza test"],
  cold: ["consultation", "general consultation"],
  headache: ["consultation", "general consultation"],
  checkup: ["general consultation", "health screening", "medical check up"],
  check: ["general consultation", "health screening"],
  screening: ["health screening", "general consultation"],
  pain: ["consultation", "general consultation"],
  sore: ["consultation", "general consultation"],
  stomach: ["consultation", "general consultation"],
  diarrhea: ["consultation", "general consultation"],
  vomiting: ["consultation", "general consultation"],
  nausea: ["consultation", "general consultation"],
  dizzy: ["consultation", "general consultation"],
  allergy: ["consultation", "allergy test"],
  rash: ["consultation", "dermatology consultation"],
  vaccine: ["vaccination", "immunisation", "immunization"],
  shot: ["vaccination", "immunisation", "immunization"],
  prenatal: ["pregnancy consultation", "antenatal"],
};

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "for", "have", "i", "im", "is", "it", "my", "of", "on", "or", "the", "to", "want", "with",
]);

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function makeSearchCacheKey(query: string, language?: string): string {
  return `v1:${normalizeText(query)}:lang=${(language ?? "unknown").toLowerCase()}`;
}

function readCachedSearch(key: string): CachedSearchResult | null {
  const item = serviceSearchCache.get(key);
  if (!item) return null;
  if (Date.now() - item.cachedAt > SEARCH_CACHE_TTL_MS) {
    serviceSearchCache.delete(key);
    return null;
  }
  return item;
}

function writeCachedSearch(key: string, value: Omit<CachedSearchResult, "cachedAt">) {
  if (serviceSearchCache.size >= SEARCH_CACHE_MAX_ITEMS) {
    const oldestKey = serviceSearchCache.keys().next().value;
    if (oldestKey) serviceSearchCache.delete(oldestKey);
  }
  serviceSearchCache.set(key, { ...value, cachedAt: Date.now() });
}

function extractSearchTerms(query: string): string[] {
  const normalized = normalizeText(query);
  if (!normalized) return [];
  const base = normalized
    .split(" ")
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  const expanded = new Set<string>(base);
  for (const w of base) {
    for (const mapped of TERM_SYNONYMS[w] ?? []) {
      const n = normalizeText(mapped);
      if (!n) continue;
      expanded.add(n);
      for (const chunk of n.split(" ").filter(Boolean)) expanded.add(chunk);
    }
  }
  return Array.from(expanded);
}

function scoreServiceMatch(row: ServiceCatalogRow, terms: string[], normalizedQuery: string): RankedServiceMatch | null {
  const name = normalizeText(row.service_name ?? "");
  const desc = normalizeText(row.description ?? "");
  const haystack = `${name} ${desc}`.trim();
  if (!haystack) return null;

  let score = 0;
  const matchedTerms = new Set<string>();
  if (normalizedQuery && name.includes(normalizedQuery)) score += 8;
  if (normalizedQuery && desc.includes(normalizedQuery)) score += 4;

  for (const term of terms) {
    if (!term) continue;
    const inName = name.includes(term);
    const inDesc = desc.includes(term);
    if (!inName && !inDesc) continue;
    matchedTerms.add(term);
    if (inName) score += term.includes(" ") ? 5 : 3;
    if (inDesc) score += term.includes(" ") ? 3 : 2;
  }

  if (score <= 0) return null;
  return { row, score, matchedTerms: Array.from(matchedTerms) };
}

async function maybeVertexRerank(
  query: string,
  ranked: RankedServiceMatch[]
): Promise<{ ordered: RankedServiceMatch[]; confidence: "high" | "medium" | "low"; reason?: string } | null> {
  if (process.env.ENABLE_SERVICE_RERANK !== "true") return null;
  const modelId = process.env.AI_VERTEX_RERANK_MODEL;
  if (!modelId) return null;

  const top = ranked.slice(0, Number(process.env.SERVICE_RERANK_CANDIDATES ?? 20));
  if (top.length < 2) return null;

  try {
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const projectId =
      process.env.VERTEX_RANKING_PROJECT_ID ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      (await auth.getProjectId());
    if (!projectId) return null;
    const rankingConfig =
      process.env.VERTEX_RANKING_CONFIG ||
      `projects/${projectId}/locations/global/rankingConfigs/default_ranking_config`;
    const endpoint = `https://discoveryengine.googleapis.com/v1/${rankingConfig}:rank`;

    const client = await auth.getClient();
    const accessTokenResult = await client.getAccessToken();
    const accessToken =
      typeof accessTokenResult === "string" ? accessTokenResult : accessTokenResult?.token;
    if (!accessToken) return null;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        topN: top.length,
        query,
        ignoreRecordDetailsInResponse: true,
        records: top.map((m) => ({
          id: m.row.id,
          title: m.row.service_name ?? "",
          content: m.row.description ?? "",
        })),
      }),
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as {
      records?: Array<{ id?: string; score?: number }>;
    };
    const apiRecords = Array.isArray(parsed.records) ? parsed.records : [];

    const byId = new Map(top.map((t) => [t.row.id, t]));
    const ordered: RankedServiceMatch[] = [];
    const scoreMap = new Map<string, number>();
    for (const record of apiRecords) {
      const id = record?.id ?? "";
      const score = typeof record?.score === "number" ? record.score : 0;
      scoreMap.set(id, score);
      const hit = byId.get(id);
      if (hit) ordered.push(hit);
    }
    for (const t of top) {
      if (!ordered.some((o) => o.row.id === t.row.id)) ordered.push(t);
    }

    const firstScore = scoreMap.get(ordered[0]?.row.id ?? "") ?? 0;
    const secondScore = scoreMap.get(ordered[1]?.row.id ?? "") ?? 0;
    const gap = firstScore - secondScore;
    const confidence: "high" | "medium" | "low" =
      firstScore >= 0.8 && gap >= 0.08 ? "high" : firstScore >= 0.6 ? "medium" : "low";

    return { ordered, confidence, reason: `ranker_score=${firstScore.toFixed(3)},gap=${gap.toFixed(3)}` };
  } catch {
    return null;
  }
}

export function createLookupTools(
  state: ThreadState,
  updateState: (partial: Partial<ThreadState>) => Promise<void>
) {
  const supabase = getSupabase();

  function normalizeDoctorSelection(clinic: Record<string, unknown>): boolean {
    const drSelection = clinic.dr_selection;
    if (typeof drSelection === "boolean") return drSelection;
    const doctorSelection = clinic.doctor_selection;
    if (typeof doctorSelection === "boolean") return doctorSelection;
    return true;
  }

  function normalizeNewPatientLimit(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async function loadClinicsByIds(clinicIds: string[]) {
    let { data, error } = await supabase
      .from("c_a_clinics")
      .select("id, name, address, dr_selection, latitude, longitude")
      .in("id", clinicIds);

    if (error?.message?.includes("does not exist")) {
      const fallback = await supabase
        .from("c_a_clinics")
        .select("id, name, address, dr_selection")
        .in("id", clinicIds);
      data = fallback.data ? fallback.data.map(row => ({ ...row, latitude: null, longitude: null })) : null;
      error = fallback.error;
    }

    return {
      data: (data ?? []) as unknown as Record<string, unknown>[],
      error: error?.message,
    };
  }

  // Shared helper: fetch and return services at a specific clinic matching a query
  async function fetchClinicServices(clinic: ClinicOption, query: string, words: string[]) {
    const orConditions = words
      .flatMap((word) => [
        `service_name.ilike.%${word}%`,
        `description.ilike.%${word}%`,
      ])
      .join(",");

    let serviceQuery = supabase
      .from("c_a_service_list")
      .select("id")
      .eq("clinic_id", clinic.clinicId)
      .limit(10);
    if (orConditions) serviceQuery = serviceQuery.or(orConditions);

    const { data: matchingServices, error: serviceError } = await serviceQuery;
    if (serviceError) {
      return JSON.stringify({ error: "Failed to load matching services", detail: serviceError.message });
    }

    const serviceIds = (matchingServices ?? []).map((s) => s.id).filter(Boolean);
    let serviceOptions: ServiceOption[] = [];
    if (serviceIds.length > 0) {
      const { data: infoRows, error: infoError } = await supabase
        .from("c_a_service_info")
        .select(`
          id, service_id, price, duration, reminder_remark,
          service:service_id(id, clinic_id, service_name, description),
          doctor:doctor_id(id, name, clinic_id),
          method:method_id(id, method, time_required, address_required)
        `)
        .in("service_id", serviceIds);
      if (infoError) {
        return JSON.stringify({ error: "Failed to load service details", detail: infoError.message });
      }
      serviceOptions = buildServiceOptions((infoRows ?? []) as unknown as ServiceInfoRow[]);
    }

    // Keep only services that score best against the normalized search intent.
    const rankedById = new Map<string, number>();
    if (query.trim()) {
      const terms = extractSearchTerms(query);
      const { data: serviceRows } = await supabase
        .from("c_a_service_list")
        .select("id, clinic_id, service_name, description")
        .eq("clinic_id", clinic.clinicId)
        .in("id", serviceIds)
        .limit(50);
      const normalizedQuery = normalizeText(query);
      const ranked = ((serviceRows ?? []) as ServiceCatalogRow[])
        .map((row) => scoreServiceMatch(row, terms, normalizedQuery))
        .filter((x): x is RankedServiceMatch => Boolean(x))
        .sort((a, b) => b.score - a.score);
      ranked.forEach((r, i) => rankedById.set(r.row.id, (r.score * 100) - i));
    }
    if (rankedById.size > 0) {
      serviceOptions = serviceOptions
        .filter((s) => rankedById.has(s.serviceId))
        .sort((a, b) => (rankedById.get(b.serviceId) ?? 0) - (rankedById.get(a.serviceId) ?? 0));
    }

    await updateState({ serviceOptions });

    if (serviceOptions.length === 0) {
      // Catalog had the service name but no bookable service_info rows.
      // Surface a service-centric message so the UI can recover. Avoid
      // naming the auto-picked clinic — the user picked a service label,
      // not a clinic, and seeing a clinic name here is confusing.
      return JSON.stringify({
        resultType: "no_bookable_services",
        searchQuery: query,
        services: [],
        message: `"${query}" isn't currently bookable. Please pick another option.`,
        instruction: "Tell the user this service isn't currently bookable.",
      });
    }

    return JSON.stringify({
      clinic: clinic.clinicName,
      address: clinic.clinicAddress,
      resultType: "matching_services",
      searchQuery: query,
      services: serviceOptions.map((s, i) => ({
        index: i + 1,
        name: s.serviceName,
        duration: `${s.durationMinutes} min`,
        price: s.price ? `RM ${s.price}` : null,
        methods: s.methods.length > 0
          ? s.methods.map((m) => m.methodName)
          : ["In-clinic visit"],
      })),
      instruction:
        "Present these as matching services for the user's request, not as the clinic's complete service catalogue. " +
        "Do not say 'offers the following services'. Say 'I found these matching services'. " +
        "When the user chooses, call select_service with the index number.",
    });
  }

  return {
    user_lookup: tool({
      description:
        "Look up the current user by their WhatsApp phone number. " +
        "Call this first at the start of every conversation. Takes no parameters.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!state.phone) {
          return "Could not determine sender identity. WhatsApp is required.";
        }

        const variants = phoneLookupVariants(state.phone);
        const { data: existingUsers, error: userError } = await supabase
          .from("wa_user")
          .select("id, username, phone_number, language")
          .in("phone_number", variants);

        if (userError) {
          return JSON.stringify({ error: "Failed to look up user", detail: userError.message });
        }

        let user = null as NonNullable<typeof existingUsers>[number] | null;
        let patientRows: LookupPatientRow[] = [];
        if ((existingUsers ?? []).length > 0) {
          const userIds = (existingUsers ?? []).map((u) => u.id);
          const { data: allPatients, error: patientError } = await supabase
            .from("patient")
            .select("id, patient_name, ic_passport, wa_user_id")
            .in("wa_user_id", userIds);

          if (patientError) {
            return JSON.stringify({ error: "Failed to load patients", detail: patientError.message });
          }

          const patientsByUser = new Map<string, LookupPatientRow[]>();
          for (const p of (allPatients ?? []) as LookupPatientRow[]) {
            if (!p.wa_user_id) continue;
            const rows = patientsByUser.get(p.wa_user_id) ?? [];
            rows.push(p);
            patientsByUser.set(p.wa_user_id, rows);
          }

          const chosen = chooseWaUserCandidate(
            (existingUsers ?? []).map((u) => ({
              ...u,
              patientCount: patientsByUser.get(u.id)?.length ?? 0,
            })),
            state.phone
          );
          user = chosen ? (existingUsers ?? []).find((u) => u.id === chosen.id) ?? null : null;
          patientRows = user ? patientsByUser.get(user.id) ?? [] : [];
        }

        let createdNow = false;
        if (!user) {
          const canonicalPhone = canonicalPhoneForInsert(state.phone);
          // Upsert on phone_number to dodge a webhook-retry race that could
          // otherwise insert two wa_user rows for the same phone.
          const { data: created, error: createError } = await supabase
            .from("wa_user")
            .upsert(
              { phone_number: canonicalPhone, username: canonicalPhone },
              { onConflict: "phone_number" }
            )
            .select("id, username, phone_number, language")
            .single();
          if (createError || !created) {
            return JSON.stringify({
              error: "Failed to create user",
              detail: createError?.message ?? "unknown",
            });
          }
          user = created;
          createdNow = true;
          console.log(`[USER_LOOKUP] Auto-created wa_user id=${user.id} phone=${canonicalPhone}`);
        }

        const patientRefs = patientRows.map((p) => ({
          id: p.id,
          name: p.patient_name,
          ic: p.ic_passport ?? "",
        }));

        await updateState({
          userId: user.id,
          patients: patientRefs,
          activePatientId: patientRefs.length === 1 ? patientRefs[0].id : undefined,
          language: user.language ?? undefined,
        });

        return JSON.stringify({
          found: true,
          createdNow,
          userName: user.username,
          language: user.language,
          patients: patientRefs.map((p, i) => ({ index: i + 1, name: p.name })),
          patientCount: patientRefs.length,
        });
      },
    }),

    select_patient: tool({
      description:
        "Select which patient to act on behalf of. " +
        "Use when user_lookup returned multiple patients and the user indicated which one.",
      inputSchema: z.object({
        index: z.number().describe("Patient number from user_lookup list (1, 2, 3, ...)"),
      }),
      execute: async ({ index }) => {
        const patients = state.patients ?? [];
        if (index < 1 || index > patients.length) {
          return JSON.stringify({
            error: `Invalid selection. Choose a number between 1 and ${patients.length}.`,
            patients: patients.map((p, i) => ({ index: i + 1, name: p.name })),
          });
        }

        const patient = patients[index - 1];
        await updateState({ activePatientId: patient.id });

        return JSON.stringify({
          success: true,
          patientName: patient.name,
          message: `Now acting on behalf of ${patient.name}.`,
        });
      },
    }),

    search_services: tool({
      description:
        "Search for clinics that offer matching services. Returns a numbered list of clinics. " +
        "After presenting clinics to the user, call select_clinic with their choice. " +
        "Use short keywords (e.g. 'heart' or 'checkup', not full sentences). " +
        "If no results, try a different keyword once — do not repeat the same query.",
      inputSchema: z.object({
        query: z.string().describe("Service name, description, or category to search for"),
      }),
      execute: async ({ query }) => {
        // Defensive guard: if a booking flow is already in progress
        // (clinic OR service already selected) and the LLM redundantly
        // re-issues search_services, refuse to wipe state and remind the
        // LLM that a selection is already active.
        if (state.activeClinicId || state.activeServiceId) {
          const activeClinic = (state.clinicOptions ?? []).find(
            (c) => c.clinicId === state.activeClinicId
          );
          const activeService = (state.serviceOptions ?? []).find(
            (s) => s.serviceId === state.activeServiceId
          );
          return JSON.stringify({
            alreadyInProgress: true,
            activeClinic: activeClinic?.clinicName ?? null,
            activeService: activeService?.serviceName ?? null,
            instruction:
              "A booking is already in progress with the selections above. Do not start a new search. " +
              "Use the active selections from the system prompt's 'Current selections' section. " +
              "If the user just said yes/confirm/ok, call create_booking. " +
              "Only call search_services again if the user explicitly asks to change clinic or service.",
          });
        }

        const words = extractSearchTerms(query);
        if (words.length === 0) {
          return JSON.stringify({
            found: false,
            message: "Please describe the symptom or service in a few keywords (e.g. fever, cough, checkup).",
          });
        }
        const normalizedQuery = normalizeText(query);
        const cacheKey = makeSearchCacheKey(query, state.language);
        const cached = readCachedSearch(cacheKey);
        if (cached) {
          await updateState({
            clinicOptions: cached.clinicOptions,
            lastSearchQuery: query,
            activeClinicId: undefined,
            activeServiceId: undefined,
            activeMethodId: undefined,
            activeDoctorId: undefined,
            serviceOptions: undefined,
            doctorOptions: undefined,
          });

          return JSON.stringify({
            found: true,
            clinics: cached.clinicOptions.map((c, i) => ({
              index: i + 1,
              name: c.clinicName,
              address: c.clinicAddress,
              matchingServices: c.matchingServiceCount,
            })),
            nearMeOption: cached.clinicOptions.length >= 2,
            rerankSource: cached.rerankSource,
            matchConfidence: cached.matchConfidence,
            topServiceCandidates: cached.topServiceCandidates,
            clarificationNeeded: cached.matchConfidence === "low",
            cacheHit: true,
            instruction:
              "Present these clinics to the user. When they choose, call select_clinic with the index number. " +
              "If nearMeOption is true, the system will append a 'Near me' option to the interactive list — if the user picks it, call search_services_near_me. " +
              "If clarificationNeeded is true, ask one clarifying question and also show topServiceCandidates as suggestions before clinic selection.",
          });
        }

        const orConditions = words
          .flatMap((word) => [
            `service_name.ilike.%${word}%`,
            `description.ilike.%${word}%`,
          ])
          .join(",");

        const { data: matchingServices, error: serviceError } = await supabase
          .from("c_a_service_list")
          .select("id, clinic_id, service_name, description")
          .or(orConditions)
          .limit(200);

        if (serviceError) {
          return JSON.stringify({ error: "Failed to search services", detail: serviceError.message });
        }

        let scoredMatches = ((matchingServices ?? []) as ServiceCatalogRow[])
          .map((row) => scoreServiceMatch(row, words, normalizedQuery))
          .filter((x): x is RankedServiceMatch => Boolean(x))
          .sort((a, b) => b.score - a.score);

        // Drop matches whose service has zero bookable c_a_service_info rows.
        // Without this, a clinic surfaces in the picker because its catalog
        // (c_a_service_list) has a keyword hit, but select_clinic then finds
        // no bookable service_info rows and shows "couldn't find matching
        // services at this clinic".
        if (scoredMatches.length > 0) {
          const candidateServiceIds = scoredMatches
            .map((m) => m.row.id)
            .filter(Boolean);
          if (candidateServiceIds.length > 0) {
            const { data: bookableRows, error: bookableError } = await supabase
              .from("c_a_service_info")
              .select("service_id")
              .in("service_id", candidateServiceIds);
            if (bookableError) {
              return JSON.stringify({
                error: "Failed to filter bookable services",
                detail: bookableError.message,
              });
            }
            const bookableServiceIds = new Set(
              (bookableRows ?? [])
                .map((r) => r.service_id as string | null)
                .filter((id): id is string => Boolean(id))
            );
            scoredMatches = scoredMatches.filter((m) =>
              bookableServiceIds.has(m.row.id)
            );
          }
        }

        if (scoredMatches.length === 0) {
          await updateState({
            clinicOptions: undefined,
            activeClinicId: undefined,
            activeServiceId: undefined,
            activeMethodId: undefined,
            activeDoctorId: undefined,
            serviceOptions: undefined,
            doctorOptions: undefined,
          });
          return JSON.stringify({ found: false, message: "No services found matching your description." });
        }

        const reranked = await maybeVertexRerank(query, scoredMatches);
        const rankedMatches = reranked?.ordered ?? scoredMatches;
        let rerankConfidence: "high" | "medium" | "low" = reranked?.confidence ?? "medium";

        // User provided an explicit service label (e.g. from clarification pick).
        // Avoid re-asking clarification when we already have a direct name hit.
        const exactNameHit = rankedMatches.some(
          (m) => normalizeText(m.row.service_name ?? "") === normalizedQuery
        );
        const prefixNameHit = !exactNameHit && rankedMatches.some(
          (m) => normalizeText(m.row.service_name ?? "").startsWith(normalizedQuery)
        );
        if (exactNameHit) {
          rerankConfidence = "high";
        } else if (prefixNameHit && rerankConfidence === "low") {
          rerankConfidence = "medium";
        }

        // Count matches per clinic. When the query exact-matches a known
        // service name (e.g. user picked "General Consultation" via clarify),
        // restrict to clinics that actually offer the exact-named service —
        // otherwise loose word matches (e.g. "Herbal Consultation" matching
        // "consultation") inflate the clinic list with clinics that have no
        // matching service at the catalog-filter step.
        const eligibleMatches = exactNameHit
          ? rankedMatches.filter(
              (m) => normalizeText(m.row.service_name ?? "") === normalizedQuery
            )
          : rankedMatches;
        const clinicCounts: Record<string, number> = {};
        for (const m of eligibleMatches.slice(0, 50)) {
          clinicCounts[m.row.clinic_id] = (clinicCounts[m.row.clinic_id] ?? 0) + 1;
        }

        const clinicIds = Object.keys(clinicCounts);
        const { data: clinics, error: clinicLoadError } = await loadClinicsByIds(clinicIds);

        if (clinicLoadError) {
          return JSON.stringify({ error: "Failed to load clinics", detail: clinicLoadError });
        }

        if (!clinics || clinics.length === 0) {
          return JSON.stringify({ found: false, message: "No clinics found." });
        }

        const clinicOptions: ClinicOption[] = clinics.map((c) => {
          const clinicId = String(c.id ?? "");
          return {
            clinicId,
            clinicName: String(c.name ?? ""),
            clinicAddress: String(c.address ?? ""),
            doctorSelection: normalizeDoctorSelection(c),
            newPatientLimit: normalizeNewPatientLimit(c.new_patient_limit),
            matchingServiceCount: clinicCounts[clinicId] ?? 0,
            latitude:
              typeof c.latitude === "number" && Number.isFinite(c.latitude)
                ? c.latitude
                : null,
            longitude:
              typeof c.longitude === "number" && Number.isFinite(c.longitude)
                ? c.longitude
                : null,
          };
        });

        await updateState({
          clinicOptions,
          lastSearchQuery: query,
          activeClinicId: undefined,
          activeServiceId: undefined,
          activeMethodId: undefined,
          activeDoctorId: undefined,
          serviceOptions: undefined,
          doctorOptions: undefined,
        });

        // Auto-select if only one clinic
        if (clinicOptions.length === 1) {
          await updateState({
            activeClinicId: clinicOptions[0].clinicId,
            activeDoctorId: undefined,
            doctorOptions: undefined,
          });
          // Immediately fetch services for this clinic
          return await fetchClinicServices(clinicOptions[0], query, words);
        }

        const topServiceCandidates = rankedMatches.slice(0, 3).map((m) => ({
          name: m.row.service_name ?? "Unnamed service",
          clinicId: m.row.clinic_id,
        }));
        const rerankSource = reranked ? "vertex-ranking-api" : "heuristic";
        writeCachedSearch(cacheKey, {
          clinicOptions,
          topServiceCandidates,
          matchConfidence: rerankConfidence,
          rerankSource,
        });

        return JSON.stringify({
          found: true,
          clinics: clinicOptions.map((c, i) => ({
            index: i + 1,
            name: c.clinicName,
            address: c.clinicAddress,
            matchingServices: c.matchingServiceCount,
          })),
          nearMeOption: clinicOptions.length >= 2,
          rerankSource,
          matchConfidence: rerankConfidence,
          topServiceCandidates,
          clarificationNeeded: rerankConfidence === "low",
          cacheHit: false,
          instruction:
            "Present these clinics to the user. When they choose, call select_clinic with the index number. " +
            "If nearMeOption is true, the system will append a 'Near me' option to the interactive list — if the user picks it, call search_services_near_me. " +
            "If clarificationNeeded is true, ask one clarifying question and also show topServiceCandidates as suggestions before clinic selection.",
        });
      },
    }),

    search_services_near_me: tool({
      description:
        "Find clinics matching a service keyword sorted by distance from the user's shared location. " +
        "Call ONLY after the user has shared their WhatsApp location. " +
        "If the user has not shared a location, this tool returns {needsLocation: true} — " +
        "in that case ask the user to share their location via WhatsApp's attachment menu (📎 → Location).",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            "Service keyword. If omitted, falls back to the most recent search query in state."
          ),
      }),
      execute: async ({ query }) => {
        if (state.activeClinicId || state.activeServiceId) {
          const activeClinic = (state.clinicOptions ?? []).find(
            (c) => c.clinicId === state.activeClinicId
          );
          const activeService = (state.serviceOptions ?? []).find(
            (s) => s.serviceId === state.activeServiceId
          );
          return JSON.stringify({
            alreadyInProgress: true,
            activeClinic: activeClinic?.clinicName ?? null,
            activeService: activeService?.serviceName ?? null,
            instruction:
              "A booking is already in progress with the selections above. Do not start a new near-me search. " +
              "Use the active selections from the system prompt's 'Current selections' section. " +
              "If the user just said yes/confirm/ok, call create_booking. " +
              "Only call search_services_near_me again if the user explicitly asks to change clinic.",
          });
        }

        const effectiveQuery = (query ?? state.lastSearchQuery ?? "").trim();
        if (!effectiveQuery) {
          return JSON.stringify({
            error:
              "No search query available. Ask the user what service they are looking for, then call search_services first.",
          });
        }

        if (!state.lastLocation) {
          return JSON.stringify({
            needsLocation: true,
            instruction:
              "Ask the user to share their location via WhatsApp's attachment menu (📎 → Location → Send). " +
              "Do not call this tool again until they share it.",
          });
        }

        const words = effectiveQuery
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 1);

        const orConditions = words
          .flatMap((word) => [
            `service_name.ilike.%${word}%`,
            `description.ilike.%${word}%`,
          ])
          .join(",");

        const { data: matchingServices, error: serviceError } = await supabase
          .from("c_a_service_list")
          .select("clinic_id")
          .or(orConditions)
          .limit(30);

        if (serviceError) {
          return JSON.stringify({
            error: "Failed to search services",
            detail: serviceError.message,
          });
        }

        const allMatches = matchingServices ?? [];
        if (allMatches.length === 0) {
          return JSON.stringify({
            found: false,
            message: "No clinics found matching that service.",
          });
        }

        const clinicCounts: Record<string, number> = {};
        for (const m of allMatches) {
          clinicCounts[m.clinic_id] = (clinicCounts[m.clinic_id] ?? 0) + 1;
        }

        const clinicIds = Object.keys(clinicCounts);
        const { data: clinics, error: clinicLoadError } = await loadClinicsByIds(clinicIds);
        if (clinicLoadError) {
          return JSON.stringify({
            error: "Failed to load clinics",
            detail: clinicLoadError,
          });
        }

        const userLoc = { lat: state.lastLocation.lat, lng: state.lastLocation.lng };

        const ranked: ClinicOption[] = [];
        const excluded: ClinicOption[] = [];

        for (const c of clinics ?? []) {
          const clinicId = String(c.id ?? "");
          const lat =
            typeof c.latitude === "number" && Number.isFinite(c.latitude)
              ? c.latitude
              : null;
          const lng =
            typeof c.longitude === "number" && Number.isFinite(c.longitude)
              ? c.longitude
              : null;

          const opt: ClinicOption = {
            clinicId,
            clinicName: String(c.name ?? ""),
            clinicAddress: String(c.address ?? ""),
            doctorSelection: normalizeDoctorSelection(c),
            newPatientLimit: normalizeNewPatientLimit(c.new_patient_limit),
            matchingServiceCount: clinicCounts[clinicId] ?? 0,
            latitude: lat,
            longitude: lng,
          };

          if (lat === null || lng === null) {
            excluded.push(opt);
          } else {
            opt.distanceKm = haversineKm(userLoc, { lat, lng });
            ranked.push(opt);
          }
        }

        ranked.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));

        await updateState({
          clinicOptions: ranked,
          lastSearchQuery: effectiveQuery,
          activeClinicId: undefined,
          activeServiceId: undefined,
          activeMethodId: undefined,
          activeDoctorId: undefined,
          serviceOptions: undefined,
          doctorOptions: undefined,
        });

        return JSON.stringify({
          found: true,
          clinics: ranked.map((c, i) => ({
            index: i + 1,
            name: c.clinicName,
            address: c.clinicAddress,
            matchingServices: c.matchingServiceCount,
            distanceKm: c.distanceKm !== undefined
              ? Number(c.distanceKm.toFixed(1))
              : null,
          })),
          excluded: excluded.map((c) => ({
            name: c.clinicName,
            address: c.clinicAddress,
            reason: "no map data",
          })),
          nearMeOption: false,
          instruction:
            "Present these clinics with their distances. When the user chooses, call select_clinic with the index number. " +
            "If any clinics are in 'excluded', mention them by name and note that we don't have their map location yet.",
        });
      },
    }),

    select_clinic: tool({
      description:
        "Select a clinic from search_services results. Shows the matching services at that clinic.",
      inputSchema: z.object({
        index: z.number().describe("Clinic number from search_services list (1, 2, 3, ...)"),
      }),
      execute: async ({ index }) => {
        const options = state.clinicOptions ?? [];
        if (index < 1 || index > options.length) {
          return JSON.stringify({
            error: `Invalid selection. Choose a number between 1 and ${options.length}.`,
          });
        }

        const clinic = options[index - 1];
        const clinicChanged = state.activeClinicId !== clinic.clinicId;
        await updateState({
          activeClinicId: clinic.clinicId,
          ...(clinicChanged
            ? {
                activeServiceId: undefined,
                activeMethodId: undefined,
                activeDoctorId: undefined,
                serviceOptions: undefined,
                doctorOptions: undefined,
              }
            : {}),
        });

        const query = state.lastSearchQuery ?? "";
        const words = extractSearchTerms(query);

        return await fetchClinicServices(clinic, query, words);
      },
    }),

    select_service: tool({
      description:
        "Select a service from select_clinic results by index number. " +
        "If the service has multiple methods, also pass the method index. " +
        "If only one method, it is auto-selected.",
      inputSchema: z.object({
        index: z.number().describe("Service number from the service list (1, 2, 3, ...)"),
        methodIndex: z.number().optional().describe("Method number if the service has multiple methods (1, 2, ...)"),
      }),
      execute: async ({ index, methodIndex }) => {
        const options = state.serviceOptions ?? [];
        if (index < 1 || index > options.length) {
          return JSON.stringify({
            error: `Invalid selection. Choose a number between 1 and ${options.length}.`,
          });
        }

        const service = options[index - 1];
        let selectedMethodId: string | undefined;
        let selectedMethod: MethodOption | undefined;

        if (service.methods.length === 0) {
          // No selectable methods
        } else if (service.methods.length === 1) {
          selectedMethod = service.methods[0];
          selectedMethodId = selectedMethod.methodId;
        } else if (methodIndex !== undefined) {
          if (methodIndex < 1 || methodIndex > service.methods.length) {
            return JSON.stringify({
              error: `Invalid method. Choose between 1 and ${service.methods.length}.`,
              methods: service.methods.map((m, i) => ({ index: i + 1, name: m.methodName })),
            });
          }
          selectedMethod = service.methods[methodIndex - 1];
          selectedMethodId = selectedMethod.methodId;
        } else {
          // Persist the service pick so the deterministic method_select_
          // handler can find it via state.activeServiceId on the next turn.
          await updateState({ activeServiceId: service.serviceId, activeMethodId: undefined });
          return JSON.stringify({
            needsMethodSelection: true,
            service: service.serviceName,
            methods: service.methods.map((m, i) => ({
              index: i + 1,
              name: m.methodName,
              requiresTime: m.requiresTime,
              requiresAddress: m.requiresAddress,
            })),
            instruction: "Ask the user which method they prefer, then call select_service again with the methodIndex.",
          });
        }

        await updateState({
          activeServiceId: service.serviceId,
          activeMethodId: selectedMethodId,
        });

        // Find clinic info from clinicOptions
        const clinicOpt = (state.clinicOptions ?? []).find((c) => c.clinicId === state.activeClinicId);

        return JSON.stringify({
          success: true,
          service: service.serviceName,
          method: selectedMethod?.methodName ?? "In-clinic visit",
          requiresTime: selectedMethod?.requiresTime ?? false,
          requiresAddress: selectedMethod?.requiresAddress ?? false,
          newPatientLimit: clinicOpt?.newPatientLimit ?? null,
          nextStep: clinicOpt?.doctorSelection
            ? "Call get_clinic_doctors to let the user pick a doctor."
            : "Clinic assigns doctors. Ask for new/existing patient if needed, then proceed to date/time.",
        });
      },
    }),

    get_clinic_doctors: tool({
      description:
        "Get doctors for the selected clinic. Call after select_service. " +
        "Takes no parameters — reads the clinic from the current selection. " +
        "If only one doctor, they are auto-selected.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!state.activeClinicId) {
          return JSON.stringify({ error: "No clinic selected. Call select_service first." });
        }

        let doctors: Array<{ id: string; name: string }> = [];
        let error: { message: string } | null = null;
        if (state.activeServiceId) {
          let serviceDoctorQuery = supabase
            .from("c_a_service_info")
            .select("doctor:doctor_id(id, name, clinic_id)")
            .eq("service_id", state.activeServiceId);
          if (state.activeMethodId) {
            serviceDoctorQuery = serviceDoctorQuery.eq("method_id", state.activeMethodId);
          }
          const { data, error: serviceDoctorError } = await serviceDoctorQuery;
          error = serviceDoctorError;
          const seen = new Set<string>();
          doctors = ((data ?? []) as any[])
            .map((row) => row.doctor)
            .filter((doctor) => doctor?.id && doctor.clinic_id === state.activeClinicId)
            .filter((doctor) => {
              if (seen.has(doctor.id)) return false;
              seen.add(doctor.id);
              return true;
            })
            .map((doctor) => ({ id: doctor.id, name: doctor.name }));
        } else {
          const { data, error: doctorError } = await supabase
            .from("c_a_doctor")
            .select("id, name")
            .eq("clinic_id", state.activeClinicId);
          error = doctorError;
          doctors = data ?? [];
        }

        if (error) {
          return JSON.stringify({ error: "Failed to load doctors", detail: error.message });
        }

        if (!doctors || doctors.length === 0) {
          return JSON.stringify({ found: false, message: "No doctors found for this clinic." });
        }

        // Auto-select if only one doctor
        if (doctors.length === 1) {
          await updateState({
            activeDoctorId: doctors[0].id,
            doctorOptions: [{ doctorId: doctors[0].id, name: doctors[0].name }],
          });
          return JSON.stringify({
            found: true,
            autoSelected: true,
            doctorName: doctors[0].name,
            message: `Dr. ${doctors[0].name} is the doctor at this clinic.`,
            nextStep: "Proceed to ask for date/time.",
          });
        }

        const doctorOptions: DoctorOption[] = doctors.map((d) => ({
          doctorId: d.id,
          name: d.name,
        }));

        await updateState({ doctorOptions });

        return JSON.stringify({
          found: true,
          doctors: doctorOptions.map((d, i) => ({ index: i + 1, name: d.name })),
          instruction: "Present the doctors to the user. When they choose, call select_doctor with the index number.",
        });
      },
    }),

    select_doctor: tool({
      description:
        "Select a doctor by index number from get_clinic_doctors results.",
      inputSchema: z.object({
        index: z.number().describe("Doctor number from get_clinic_doctors list (1, 2, 3, ...)"),
      }),
      execute: async ({ index }) => {
        const options = state.doctorOptions ?? [];
        if (index < 1 || index > options.length) {
          return JSON.stringify({
            error: `Invalid selection. Choose a number between 1 and ${options.length}.`,
          });
        }

        const doctor = options[index - 1];
        await updateState({ activeDoctorId: doctor.doctorId });

        return JSON.stringify({
          success: true,
          doctorName: doctor.name,
          nextStep: "Proceed to ask for date/time.",
        });
      },
    }),

    get_clinic_availability: tool({
      description:
        "Check clinic opening hours for a given day. Reads the clinic from current selection. " +
        "Returns operating hours, lunch breaks, and booked slots. You must calculate free times from gaps.",
      inputSchema: z.object({
        date: z.string().describe("Date to check in YYYY-MM-DD format"),
        isNewPatient: z.boolean().optional().describe("Whether this booking is for a new patient"),
      }),
      execute: async ({ date, isNewPatient }) => {
        const clinicId = state.activeClinicId;
        if (!clinicId) {
          return JSON.stringify({ error: "No clinic selected. Call select_service first." });
        }

        const clinicOpt = (state.clinicOptions ?? []).find((c) => c.clinicId === clinicId);
        const newPatientLimit = clinicOpt?.newPatientLimit ?? null;

        const { data: hours, error: hoursError } = await supabase
          .from("c_a_clinic_time")
          .select("*")
          .eq("clinic_id", clinicId)
          .limit(1)
          .maybeSingle();

        if (hoursError || !hours) {
          return JSON.stringify({ error: "Could not find clinic hours" });
        }

        const dayOfWeek = new Date(date).toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
        const { data: publicHoliday } = await supabase
          .from("c_a_ph")
          .select("date")
          .eq("date", date)
          .maybeSingle();
        const dayKey = publicHoliday ? "public_holiday" : dayOfWeek;

        const dayStart = hours[`${dayKey}_start${publicHoliday ? "" : "_time"}` as keyof typeof hours];
        const dayEnd = hours[`${dayKey}_end${publicHoliday ? "" : "_time"}` as keyof typeof hours];
        const breaks = Array.from({ length: 5 }, (_, i) => {
          const n = i + 1;
          const prefix = publicHoliday ? "ph" : dayOfWeek;
          const start = hours[`${prefix}_break${n}_start` as keyof typeof hours];
          const end = hours[`${prefix}_break${n}_end` as keyof typeof hours];
          return start && end ? { start, end } : null;
        }).filter(Boolean);
        const lunchStart = (breaks[0] as any)?.start;
        const lunchEnd = (breaks[0] as any)?.end;

        if (!dayStart || !dayEnd) {
          return JSON.stringify({ open: false, message: `Clinic is closed on ${dayOfWeek}s.` });
        }

        const { data: clinicDoctors, error: doctorError } = await supabase
          .from("c_a_doctor")
          .select("id")
          .eq("clinic_id", clinicId);

        if (doctorError) {
          return JSON.stringify({ error: "Failed to load clinic doctors", detail: doctorError.message });
        }

        const clinicDoctorIds = (clinicDoctors ?? []).map((d) => d.id);
        if (clinicDoctorIds.length === 0) {
          return JSON.stringify({
            open: true,
            dayOfWeek,
            hours: { start: dayStart, end: dayEnd },
            lunch: lunchStart && lunchEnd ? { start: lunchStart, end: lunchEnd } : null,
            bookedSlots: [],
            newPatientLimit,
            newPatientBookedSlots: [],
            newPatientSlotsAtLimit: [],
          });
        }

        let bookingQuery = supabase
          .from("c_s_bookings")
          .select(`
            id, original_time, reschedule_time, status,
            service_info:service_info_id(duration, doctor_id)
          `)
          .or(`original_date.eq.${date},reschedule_date.eq.${date}`)
          .not("status", "in", "(cancelled,declined)");

        const { data: bookings } = await bookingQuery;

        const scopedBookings = (bookings ?? []).filter((b) => {
          const info = (b as any).service_info;
          if (!info?.doctor_id || !clinicDoctorIds.includes(info.doctor_id)) return false;
          return !state.activeDoctorId || info.doctor_id === state.activeDoctorId;
        });

        const bookedTimes = scopedBookings.map((b) => ({
          time: (b as any).reschedule_time ?? b.original_time,
          duration: ((b as any).service_info?.duration as number | null) ?? 30,
        }));

        // Server-side free-slot computation. The LLM was asked to compute
        // gaps from raw hours + booked slots; it routinely got it wrong.
        const slotDuration = 30;
        const timeToMin = (t: unknown): number | null => {
          if (typeof t !== "string") return null;
          const m = /^(\d{1,2}):(\d{2})/.exec(t);
          if (!m) return null;
          const h = Number(m[1]);
          const mn = Number(m[2]);
          if (!Number.isFinite(h) || !Number.isFinite(mn)) return null;
          return h * 60 + mn;
        };
        const minToTime = (m: number): string =>
          `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
        const startMin = timeToMin(dayStart);
        const endMin = timeToMin(dayEnd);
        const freeSlots: string[] = [];
        if (startMin !== null && endMin !== null && endMin > startMin) {
          const blocked: Array<{ s: number; e: number }> = [];
          for (const br of breaks as Array<{ start: unknown; end: unknown }>) {
            const s = timeToMin((br as any).start);
            const e = timeToMin((br as any).end);
            if (s !== null && e !== null && e > s) blocked.push({ s, e });
          }
          for (const b of bookedTimes) {
            const s = timeToMin((b as any).time);
            if (s === null) continue;
            const dur = typeof (b as any).duration === "number" && (b as any).duration > 0
              ? (b as any).duration
              : 30;
            blocked.push({ s, e: s + dur });
          }
          blocked.sort((a, b) => a.s - b.s);

          // For today, hide slots earlier than (now + 30 min) to avoid
          // suggesting effectively-impossible times.
          const todayYmd = (() => {
            const d = new Date();
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, "0");
            const dd = String(d.getDate()).padStart(2, "0");
            return `${y}-${m}-${dd}`;
          })();
          const isToday = date === todayYmd;
          const earliestForToday = isToday
            ? new Date().getHours() * 60 + new Date().getMinutes() + 30
            : -1;

          let cursor = Math.max(startMin, earliestForToday);
          // Round cursor up to the next 30-min mark.
          if (cursor % slotDuration !== 0) cursor = Math.ceil(cursor / slotDuration) * slotDuration;

          let safety = 0;
          while (cursor + slotDuration <= endMin && safety++ < 200) {
            const slotEnd = cursor + slotDuration;
            const conflict = blocked.find((bl) => bl.s < slotEnd && bl.e > cursor);
            if (conflict) {
              cursor = Math.ceil(conflict.e / slotDuration) * slotDuration;
              continue;
            }
            freeSlots.push(minToTime(cursor));
            cursor += slotDuration;
          }
        }

        const newPatientBookedSlots: Array<{ time: string | null; duration: number }> = [];

        const countByStartTime: Record<string, number> = {};
        for (const slot of newPatientBookedSlots) {
          if (!slot.time) continue;
          countByStartTime[slot.time] = (countByStartTime[slot.time] ?? 0) + 1;
        }

        const newPatientSlotsAtLimit =
          isNewPatient && newPatientLimit !== null
            ? Object.entries(countByStartTime)
                .filter(([, count]) => count >= newPatientLimit)
                .map(([time, count]) => ({ time, count, limit: newPatientLimit }))
            : [];

        return JSON.stringify({
          open: true,
          dayOfWeek: publicHoliday ? "public holiday" : dayOfWeek,
          hours: { start: dayStart, end: dayEnd },
          lunch: lunchStart && lunchEnd ? { start: lunchStart, end: lunchEnd } : null,
          breaks,
          bookedSlots: bookedTimes,
          freeSlots,
          newPatientLimit,
          newPatientBookedSlots,
          newPatientSlotsAtLimit,
        });
      },
    }),
  };
}
