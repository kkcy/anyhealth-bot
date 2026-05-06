-- 005_meal_logs.sql
-- WhatsApp bot food-photo nutrition logging

create table if not exists meal_logs (
  id                 uuid primary key default gen_random_uuid(),
  patient_id         uuid references patient(id) on delete set null,
  phone              text not null,
  logged_at          timestamptz not null default now(),
  photo_url          text not null,
  items              jsonb not null,
  total_kcal         numeric not null,
  total_protein_g    numeric not null,
  total_carb_g       numeric not null,
  total_fat_g        numeric not null,
  total_fiber_g      numeric,
  total_sugar_g      numeric,
  total_sodium_mg    numeric,
  source             text not null default 'bot',
  vision_model       text not null,
  nutrition_provider text not null default 'gemini-only',
  confirmed_at       timestamptz not null,
  created_at         timestamptz not null default now()
);

create index if not exists meal_logs_patient_logged_at on meal_logs (patient_id, logged_at desc);
create index if not exists meal_logs_phone_logged_at   on meal_logs (phone, logged_at desc);

comment on table  meal_logs                    is 'Food meals logged by patients via WhatsApp bot photo flow';
comment on column meal_logs.patient_id         is 'Null when logged before patient verification — backfill later by phone';
comment on column meal_logs.items              is 'JSONB array of {name, portion, source, kcal, protein_g, carb_g, fat_g, fiber_g, sugar_g, sodium_mg, edamam_food_id?}';
comment on column meal_logs.nutrition_provider is 'gemini-only | edamam | edamam-degraded';
