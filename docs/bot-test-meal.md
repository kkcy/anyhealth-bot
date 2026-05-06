# Meal Photo Flow Test

## Scope
Validate WhatsApp meal-photo logging flow end-to-end:
- inbound image media intake
- food identification
- confirm/edit/cancel buttons
- optional patient picker for multi-patient accounts
- `meal_logs` insert with stable storage path

## Preconditions
- Vertex AI configured: `AI_MODEL=vertex/gemini-2.5-flash`, `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION`, ADC via `gcloud auth application-default login` or `GOOGLE_APPLICATION_CREDENTIALS`
- `NUTRITION_PROVIDER` set (`gemini` or `edamam`). `gemini` means vision model returns macros; no separate Gemini API key needed since vision uses Vertex.
- If `edamam`, set `EDAMAM_APP_ID` and `EDAMAM_APP_KEY`
- Supabase migrations applied:
  - `005_meal_logs.sql`
  - `006_meal_photos_bucket.sql`
- WhatsApp webhook is reachable

## Manual Test Cases
1. Food photo accepted
- Send clear meal image
- Expect summary + 3 buttons (`Confirm`, `Edit`, `Cancel`)

2. Non-food rejected
- Send non-food image (ID card)
- Expect rejection message and no log insert

3. Confirm logs meal
- Tap `Confirm`
- Expect success message
- Verify DB row in `meal_logs`

4. Edit flow
- Tap `Edit`
- Send correction text
- Expect updated summary + buttons

5. Edit cap
- Repeat edit >3 times
- Expect cap message and request for new photo

6. Cancel flow
- Tap `Cancel`
- Expect cancellation message
- No DB insert

7. Multi-patient picker
- Use account with multiple linked patients and no active patient
- Tap `Confirm`
- Expect patient picker list
- Tap patient -> expect logged meal under selected `patient_id`

## DB Checks
- `meal_logs.photo_url` should be storage path (`<hash>/<timestamp>.<ext>`), not signed URL
- `meal_logs.phone` should match thread state phone format
- Nutrition totals should be non-zero for valid meals

