-- 002_clinic_geo.sql
-- Add geographic coordinates to c_a_clinics for the bot's "near me" feature.

alter table c_a_clinics
  add column if not exists latitude double precision,
  add column if not exists longitude double precision;

comment on column c_a_clinics.latitude is 'Decimal degrees, WGS84. NULL until backfilled.';
comment on column c_a_clinics.longitude is 'Decimal degrees, WGS84. NULL until backfilled.';

-- Manual backfill happens in a separate one-off SQL run by an operator.
-- Do not invent coordinates here.
