-- 003_clinic_slug.sql
-- Adds a URL-safe slug to c_a_clinics for WhatsApp deep-link routing.

BEGIN;

ALTER TABLE c_a_clinics ADD COLUMN IF NOT EXISTS slug text;

-- Backfill from name: lowercase, strip non-alphanumeric (keep space, hyphen),
-- collapse runs of space/hyphen to single hyphen, trim, truncate to 37 chars
-- (room for up to "-99" disambiguation suffix without exceeding 40-char URL cap).
UPDATE c_a_clinics
SET slug = TRIM(BOTH '-' FROM
  LEFT(
    REGEXP_REPLACE(
      REGEXP_REPLACE(LOWER(COALESCE(name, '')), '[^a-z0-9 -]', '', 'g'),
      '[\s-]+', '-', 'g'
    ),
    37
  )
);

-- Fallback for empty slugs (e.g. names with only non-Latin chars).
UPDATE c_a_clinics
SET slug = 'clinic-' || SUBSTRING(id::text, 1, 8)
WHERE slug IS NULL OR slug = '';

-- Note: this can theoretically collide if a clinic's natural slug already
-- equals another clinic's disambiguated form (e.g. names "Dental" + "Dental 2").
-- Not a concern at MVP scale; if it ever fails, manually adjust slugs.
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

COMMENT ON COLUMN c_a_clinics.slug IS 'URL-safe kebab-case identifier for WhatsApp deep-link routing. Pattern: ^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$';

COMMIT;
