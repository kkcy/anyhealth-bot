export interface PatientRef {
  id: string;
  name: string;
  ic: string;
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
}
