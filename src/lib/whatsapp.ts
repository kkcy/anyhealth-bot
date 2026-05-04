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
  kind: "buttons" | "list" | "location_request";
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

export async function sendLocationRequest(
  to: string,
  body: string
): Promise<boolean> {
  if (isTestMode()) {
    captureQueue.push({
      kind: "location_request",
      to,
      body,
      options: [{ id: "send_location", title: "Send location" }],
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
        type: "location_request_message",
        body: { text: body },
        action: { name: "send_location" },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[WHATSAPP] sendLocationRequest failed (${res.status}):`, detail);
    return false;
  }
  return true;
}

// ---------- Templates ----------

export type TemplateSendKind =
  | "ok"
  | "transient"
  | "permanent_block"
  | "permanent_template";

export interface TemplateSendResult {
  kind: TemplateSendKind;
  detail?: string;
  metaCode?: number;
}

export interface MetaErrorInput {
  http: number;            // HTTP status, 0 if network error
  metaCode?: number;       // Meta error.code from response body
  body: string;            // raw response body text
}

const PERMANENT_BLOCK_CODES = new Set<number>([131026, 131047, 131049]);

export function classifyMetaError(e: MetaErrorInput): TemplateSendResult {
  if (e.http >= 200 && e.http < 300) return { kind: "ok" };
  if (e.metaCode && PERMANENT_BLOCK_CODES.has(e.metaCode)) {
    return { kind: "permanent_block", metaCode: e.metaCode, detail: e.body };
  }
  if (e.metaCode && e.metaCode >= 132000 && e.metaCode < 133000) {
    return { kind: "permanent_template", metaCode: e.metaCode, detail: e.body };
  }
  if (e.http >= 500 || e.http === 0) {
    return { kind: "transient", detail: e.body };
  }
  // Unknown 4xx: fail-safe transient, will retry up to attempts cap.
  return { kind: "transient", detail: e.body, metaCode: e.metaCode };
}

export interface TemplateComponent {
  type: "body" | "button" | "header";
  sub_type?: "quick_reply" | "url";
  index?: string;
  parameters?: Array<
    | { type: "text"; text: string; parameter_name?: string }
    | { type: "payload"; payload: string; parameter_name?: string }
  >;
}

export async function sendTemplate(args: {
  to: string;
  name: string;
  lang: string;
  components: TemplateComponent[];
}): Promise<TemplateSendResult> {
  if (isTestMode()) {
    captureQueue.push({
      kind: "buttons", // re-use existing capture shape for snapshotting
      to: args.to,
      body: `template:${args.name}`,
      options: args.components
        .filter((c) => c.type === "button")
        .map((c) => ({
          id: (c.parameters?.[0] as any)?.payload ?? "",
          title: "(template button)",
        })),
    });
    return { kind: "ok" };
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    return { kind: "transient", detail: "missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN" };
  }

  let res: Response;
  try {
    res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: args.to,
        type: "template",
        template: {
          name: args.name,
          language: { code: args.lang },
          components: args.components,
        },
      }),
    });
  } catch (err) {
    return classifyMetaError({ http: 0, metaCode: undefined, body: String(err) });
  }

  const body = await res.text().catch(() => "");
  let metaCode: number | undefined;
  try {
    const parsed = JSON.parse(body);
    metaCode = parsed?.error?.code;
  } catch { /* non-JSON response */ }

  return classifyMetaError({ http: res.status, metaCode, body });
}

