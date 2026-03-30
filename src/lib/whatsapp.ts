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

export async function sendReplyButtons(
  to: string,
  body: string,
  buttons: ReplyButton[]
): Promise<void> {
  if (buttons.length > 3) {
    throw new Error("WhatsApp allows max 3 reply buttons");
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
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
}

export async function sendListMessage(
  to: string,
  body: string,
  buttonText: string,
  sections: ListSection[]
): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
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
}
