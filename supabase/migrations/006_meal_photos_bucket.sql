-- 006_meal_photos_bucket.sql
-- Storage bucket for patient meal photos

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'meal-photos',
  'meal-photos',
  false,
  5242880,                                 -- 5 MB
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do nothing;

-- Service role only — bot accesses via SUPABASE_SECRET_KEY
-- No public RLS policies; all access through bot backend with signed URLs.
