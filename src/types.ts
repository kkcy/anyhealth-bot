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
}
