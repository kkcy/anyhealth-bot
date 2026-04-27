-- 003_clinic_slug.sql
-- Adds a URL-safe slug to c_a_clinics for WhatsApp deep-link routing.

BEGIN;

ALTER TABLE c_a_clinics ADD COLUMN slug text;

-- Backfill from name: lowercase, strip non-alphanumeric (keep space, hyphen),
-- collapse runs of space/hyphen to single hyphen, trim, truncate to 40 chars.
UPDATE c_a_clinics
SET slug = TRIM(BOTH '-' FROM
  LEFT(
    REGEXP_REPLACE(
      REGEXP_REPLACE(LOWER(COALESCE(name, '')), '[^a-z0-9 -]', '', 'g'),
      '[\s-]+', '-', 'g'
    ),
    40
  )
);

-- Fallback for empty slugs (e.g. names with only non-Latin chars).
UPDATE c_a_clinics
SET slug = 'clinic-' || SUBSTRING(id::text, 1, 8)
WHERE slug IS NULL OR slug = '';

-- Disambiguate collisions with -2, -3, ...
WITH numbered AS (
  SELECT id, slug,
    ROW_NUMBER() OVER (PARTITION BY slug ORDER BY id) AS rn
  FROM c_a_clinics
)
UPDATE c_a_clinics c
SET slug = CASE WHEN n.rn = 1 THEN c.slug ELSE c.slug || '-' || n.rn END
FROM numbered n
WHERE c.id = n.id;

ALTER TABLE c_a_clinics ALTER COLUMN slug SET NOT NULL;
ALTER TABLE c_a_clinics ADD CONSTRAINT c_a_clinics_slug_key UNIQUE (slug);

COMMIT;
