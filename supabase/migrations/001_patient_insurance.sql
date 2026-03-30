CREATE TABLE IF NOT EXISTS patient_insurance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id    uuid REFERENCES patient_id(id),
  insurer_name  text,
  policy_number text,
  raw_text      text,
  file_url      text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);
