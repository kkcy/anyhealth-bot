import type { EnrichedItem } from "@/lib/nutrition/types";

export interface PatientRef {
  id: string;
  name: string;
  ic: string;
}

export interface ClinicOption {
  clinicId: string;
  clinicName: string;
  clinicAddress: string;
  doctorSelection: boolean;
  newPatientLimit: number | null;
  matchingServiceCount: number;
  latitude?: number | null;
  longitude?: number | null;
  distanceKm?: number;
}

export interface ServiceOption {
  serviceId: string;
  serviceName: string;
  description: string;
  durationMinutes: number;
  price: number | null;
  reminderRemark?: string;
  methods: MethodOption[];
}

export interface MethodOption {
  methodId?: string;
  methodName: string;
  requiresTime: boolean;
  requiresAddress: boolean;
}

export interface DoctorOption {
  doctorId: string;
  name: string;
}

export interface ThreadState {
  phone: string;
  userId?: string;
  patients?: PatientRef[];
  activePatientId?: string;
  language?: string;
  verified: boolean;
  verifyAttempts: number;
  activeInsuranceId?: string;

  // Booking selections (set by search → select_clinic → select_service → select_doctor)
  lastSearchQuery?: string;
  clinicOptions?: ClinicOption[];
  serviceOptions?: ServiceOption[];
  doctorOptions?: DoctorOption[];
  activeClinicId?: string;
  activeServiceId?: string;
  activeMethodId?: string;
  activeDoctorId?: string;

  // Most recent WhatsApp location share. Cached for the session so the user
  // is not re-prompted for a second "near me" search.
  lastLocation?: {
    lat: number;
    lng: number;
    capturedAt: number;
  };

  // Deep-link routing — one-shot, cleared at end of turn.
  unknownSlugThisTurn?: boolean;

  /** Set when user taps "View booking" on a reminder template. Cleared next non-button turn. */
  activeBookingId?: string;

  /** Set when user taps "Get document" on a doc-ready reminder. Cleared next non-button turn. */
  pendingDocRetrievalBookingId?: string;

  // Deterministic interactive flow guards
  pendingSelectionType?: "service_clarify" | "clinic";
  pendingSelectionQuery?: string;

  /**
   * Booking args staged by create_booking({confirmed:false}). On Yes button
   * the deterministic handler re-runs create_booking with these + confirmed:true.
   */
  pendingBooking?: {
    date: string;
    time?: string;
    address?: string;
    reminderRemark?: string;
    isNewPatient?: boolean;
    bookingType?: "checkup" | "consultation" | "vaccination";
  };

  /** Date picked via the deterministic date list, awaiting time selection. */
  pendingBookingDate?: string;

  /** Yes/No answer to "is this for a new patient?", recorded before time pick. */
  pendingIsNewPatient?: boolean;

  /**
   * Set when the picked method needs an address: the next plain-text turn
   * is treated as the address rather than free-form input for the LLM.
   */
  awaitingAddress?: boolean;

  /**
   * Set when the user picked "Other time": the next plain-text turn is
   * parsed as HH:mm and treated as the booking time.
   */
  awaitingTime?: boolean;

  /**
   * Set when the user picked "Other date": the next plain-text turn is
   * parsed as a date and routed through the time picker.
   */
  awaitingDate?: boolean;

  /**
   * Set by start_document_access when a patient picker is shown. After the
   * user taps a patient, the deterministic patient_select_ handler posts the
   * "share name + IC" prompt and clears this flag.
   */
  awaitingDocVerification?: boolean;

  pendingMealAnalysis?: {
    imageUrl: string;
    storagePath: string;
    items: EnrichedItem[];
    totals: {
      kcal: number;
      protein_g: number;
      carb_g: number;
      fat_g: number;
      fiber_g: number;
      sugar_g: number;
      sodium_mg: number;
    };
    providerUsed: string;
    visionModel: string;
  };

  awaitingMealEditText?: boolean;
  mealEditRoundCount?: number;
  awaitingMealPatientPick?: boolean;
}
