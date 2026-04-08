export interface PatientRef {
  id: string;
  name: string;
  ic: string;
}

export interface ServiceOption {
  serviceId: string;
  serviceName: string;
  clinicId: string;
  clinicName: string;
  clinicAddress: string;
  doctorSelection: boolean;
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

  // Booking selections (set by select_service, select_doctor)
  serviceOptions?: ServiceOption[];
  doctorOptions?: DoctorOption[];
  activeServiceId?: string;
  activeClinicId?: string;
  activeMethodId?: string;
  activeDoctorId?: string;
}
