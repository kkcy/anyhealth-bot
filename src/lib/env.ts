const REQUIRED_ENV_VARS = [
  "AI_MODEL",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_BUSINESS_PHONE",
  "POSTGRES_URL",
] as const;

const VALID_PROVIDERS = ["gemini", "edamam"] as const;
type Provider = (typeof VALID_PROVIDERS)[number];

export function validateEnv() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.map((k) => `  - ${k}`).join("\n")}`
    );
  }

  const provider = (process.env.NUTRITION_PROVIDER ?? "gemini") as string;
  if (!VALID_PROVIDERS.includes(provider as Provider)) {
    throw new Error(
      `NUTRITION_PROVIDER must be one of ${VALID_PROVIDERS.join("|")}, got "${provider}"`
    );
  }
  if (provider === "edamam") {
    const edamamMissing = ["EDAMAM_APP_ID", "EDAMAM_APP_KEY"].filter((k) => !process.env[k]);
    if (edamamMissing.length > 0) {
      throw new Error(
        `NUTRITION_PROVIDER=edamam requires:\n${edamamMissing.map((k) => `  - ${k}`).join("\n")}`
      );
    }
  }
}

export function getNutritionProvider(): Provider {
  return ((process.env.NUTRITION_PROVIDER ?? "gemini") as Provider);
}
