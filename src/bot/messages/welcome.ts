type Lang = "en" | "ms" | "zh";

const TEMPLATES: Record<Lang, (clinicName: string) => string> = {
  en: (n) => `Hi! You're booking at *${n}*. What service do you need today?`,
  ms: (n) => `Hai! Anda sedang menempah di *${n}*. Apakah perkhidmatan yang anda perlukan hari ini?`,
  zh: (n) => `您好！您正在 *${n}* 预约。请问您需要什么服务？`,
};

function pickLang(language: string | undefined): Lang {
  if (language === "ms" || language === "zh") return language;
  return "en";
}

export function buildWelcomeText(clinicName: string, language: string | undefined): string {
  return TEMPLATES[pickLang(language)](clinicName);
}

/**
 * Sends a deterministic clinic-named welcome via the existing thread.post helper.
 */
export async function sendWelcome(
  thread: { post: (text: string) => Promise<unknown> },
  clinic: { name: string },
  language: string | undefined,
): Promise<void> {
  const text = buildWelcomeText(clinic.name, language);
  await thread.post(text);
}
