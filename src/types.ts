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
  matchingServiceCount: number;
}

export interface ServiceOption {
  serviceId: string;
  serviceName: string;
  description: string;
  durationMinutes: number;
  price: number | null;
  methods: MethodOption[];
}

export interface MethodOption {
  methodId: string;
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
}
