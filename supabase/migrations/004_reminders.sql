-- Booking reminders: queue + per-clinic opt-outs.

CREATE TABLE IF NOT EXISTS reminder_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    uuid NOT NULL,
  user_id       uuid NOT NULL,
  clinic_id     uuid NOT NULL,
  phone         text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('appt_24h','appt_2h','doc_ready')),
  template_name text NOT NULL,
  template_vars jsonb NOT NULL,
  send_at       timestamptz NOT NULL,
  sent_at       timestamptz,
  attempts      int NOT NULL DEFAULT 0,
  last_error    text,
  failed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_booking FOREIGN KEY (booking_id) REFERENCES c_s_bookings(id) ON DELETE CASCADE,
  CONSTRAINT fk_clinic FOREIGN KEY (clinic_id) REFERENCES c_a_clinics(id)
);

ALTER TABLE reminder_jobs ENABLE ROW LEVEL SECURITY;

-- Sweeper hot path. Partial index keeps it small.
CREATE INDEX IF NOT EXISTS reminder_jobs_due_idx
  ON reminder_jobs (send_at)
  WHERE sent_at IS NULL AND failed_at IS NULL;

-- Recompute path: delete-by-booking_id.
CREATE INDEX IF NOT EXISTS reminder_jobs_booking_idx
  ON reminder_jobs (booking_id);

-- (booking_id, kind) is unique per pending row to defend against double-enqueue races.
CREATE UNIQUE INDEX IF NOT EXISTS reminder_jobs_pending_unique
  ON reminder_jobs (booking_id, kind);


CREATE TABLE IF NOT EXISTS reminder_optouts (
  phone     text NOT NULL,
  clinic_id uuid,                           -- NULL = global mute (all clinics)
  muted_at  timestamptz NOT NULL DEFAULT now(),
  source    text NOT NULL CHECK (source IN ('button','command','auto_block'))
);

-- Primary key on (phone, clinic_id) would fail for NULL clinic_id (global mute).
-- Using partial indexes to enforce uniqueness for both clinic-specific and global mutes.
CREATE UNIQUE INDEX IF NOT EXISTS reminder_optouts_clinic_unique_idx ON reminder_optouts (phone, clinic_id) WHERE clinic_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reminder_optouts_global_unique_idx ON reminder_optouts (phone) WHERE clinic_id IS NULL;

ALTER TABLE reminder_optouts ENABLE ROW LEVEL SECURITY;

-- Internal tables: default to locked down. service_role bypasses RLS.
-- Policies can be added here if authenticated users ever need direct access.

