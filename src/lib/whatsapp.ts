/**
 * WhatsApp interactive message helpers.
 * Uses Meta Cloud API directly for message types that Chat SDK may not support.
 */

interface ReplyButton {
  id: string;
  title: string; // Max 20 chars
}

interface ListRow {
  id: string;
  title: string;       // Max 24 chars
  description?: string; // Max 72 chars
}

interface ListSection {
  title: string;  // Max 24 chars
  rows: ListRow[];
}

export interface CapturedInteractive {
  kind: "buttons" | "list";
  to: string;
  body: string;
  options: Array<{ id: string; title: string; description?: string }>;
}

const captureQueue: CapturedInteractive[] = [];

function isTestMode(): boolean {
  return process.env.BOT_TEST_MODE === "1";
}

export function drainCapturedInteractive(): CapturedInteractive[] {
  const out = captureQueue.splice(0, captureQueue.length);
  return out;
}

export function clearCapturedInteractive(): void {
  captureQueue.length = 0;
}

export async function sendReplyButtons(
  to: string,
  body: string,
  buttons: ReplyButton[]
): Promise<boolean> {
  if (buttons.length > 3) {
    throw new Error("WhatsApp allows max 3 reply buttons");
  }

  if (isTestMode()) {
    captureQueue.push({
      kind: "buttons",
      to,
      body,
      options: buttons.map((b) => ({ id: b.id, title: b.title })),
    });
    return true;
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    console.warn("[WHATSAPP] Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN");
    return false;
  }

  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[WHATSAPP] sendReplyButtons failed (${res.status}):`, detail);
    return false;
  }
  return true;
}

export async function sendListMessage(
  to: string,
  body: string,
  buttonText: string,
  sections: ListSection[]
): Promise<boolean> {
  if (isTestMode()) {
    captureQueue.push({
      kind: "list",
      to,
      body,
      options: sections.flatMap((s) =>
        s.rows.map((r) => ({ id: r.id, title: r.title, description: r.description }))
      ),
    });
    return true;
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    console.warn("[WHATSAPP] Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN");
    return false;
  }

  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body },
        action: {
          button: buttonText, // Max 20 chars
          sections: sections.map((s) => ({
            title: s.title,
            rows: s.rows.map((r) => ({
              id: r.id,
              title: r.title,
              description: r.description,
            })),
          })),
        },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[WHATSAPP] sendListMessage failed (${res.status}):`, detail);
    return false;
  }
  return true;
}
