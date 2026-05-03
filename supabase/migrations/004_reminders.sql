-- Booking reminders: queue + per-clinic opt-outs.

CREATE TABLE IF NOT EXISTS reminder_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    text NOT NULL,
  user_id       text NOT NULL,
  clinic_id     text NOT NULL,
  phone         text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('appt_24h','appt_2h','doc_ready')),
  template_name text NOT NULL,
  template_vars jsonb NOT NULL,
  send_at       timestamptz NOT NULL,
  sent_at       timestamptz,
  attempts      int NOT NULL DEFAULT 0,
  last_error    text,
  failed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Sweeper hot path. Partial index keeps it small.
CREATE INDEX IF NOT EXISTS reminder_jobs_due_idx
  ON reminder_jobs (send_at)
  WHERE sent_at IS NULL AND failed_at IS NULL;

-- Recompute path: delete-by-booking_id.
CREATE INDEX IF NOT EXISTS reminder_jobs_booking_idx
  ON reminder_jobs (booking_id);

-- (booking_id, kind) is unique per pending row to defend against double-enqueue races.
CREATE UNIQUE INDEX IF NOT EXISTS reminder_jobs_pending_unique
  ON reminder_jobs (booking_id, kind)
  WHERE sent_at IS NULL AND failed_at IS NULL;


CREATE TABLE IF NOT EXISTS reminder_optouts (
  phone     text NOT NULL,
  clinic_id text,                           -- NULL = global mute (all clinics)
  muted_at  timestamptz NOT NULL DEFAULT now(),
  source    text NOT NULL CHECK (source IN ('button','command','auto_block')),
  PRIMARY KEY (phone, clinic_id)
);
