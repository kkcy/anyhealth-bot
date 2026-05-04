import { formatTimeMYT } from "../time";
import type { TemplateComponent } from "../whatsapp";
import type { BookingForReminder, ReminderKind } from "./types";

export function pickTemplateName(
  kind: ReminderKind,
  booking: Pick<BookingForReminder, "doctor_name">,
): string {
  if (kind === "doc_ready") return "doc_ready";
  const variant = booking.doctor_name ? "with_doctor" : "no_doctor";
  return `${kind}_${variant}`;
}

export function buildTemplateVars(
  kind: ReminderKind,
  booking: BookingForReminder,
  overrides: Partial<{ doc_type: string }> = {},
): Record<string, string> {
  if (kind === "doc_ready") {
    return {
      patient_name: booking.patient_name,
      doc_type: overrides.doc_type ?? "document",
      clinic_name: booking.clinic_name,
    };
  }
  const vars: Record<string, string> = {
    patient_name: booking.patient_name,
    clinic_name: booking.clinic_name,
    time_string: formatTimeMYT(booking.appointment_at),
  };
  if (booking.doctor_name) vars.doctor_name = booking.doctor_name;
  return vars;
}

interface BuildArgs {
  template_name: string;
  template_vars: Record<string, string>;
  booking_id: string;
  clinic_id: string;
}

export function buildComponents(args: BuildArgs): TemplateComponent[] {
  const v = args.template_vars;
  let bodyParams: Array<{ text: string; name: string }>;
  let primaryPayload: string;

  switch (args.template_name) {
    case "appt_24h_with_doctor":
    case "appt_2h_with_doctor":
      bodyParams = [
        { text: v.patient_name, name: "patient_name" },
        { text: v.clinic_name, name: "clinic_name" },
        { text: v.time_string, name: "time_string" },
        { text: v.doctor_name, name: "doctor_name" },
      ];
      primaryPayload = `view_booking:${args.booking_id}`;
      break;
    case "appt_24h_no_doctor":
    case "appt_2h_no_doctor":
      bodyParams = [
        { text: v.patient_name, name: "patient_name" },
        { text: v.clinic_name, name: "clinic_name" },
        { text: v.time_string, name: "time_string" },
      ];
      primaryPayload = `view_booking:${args.booking_id}`;
      break;
    case "doc_ready":
      bodyParams = [
        { text: v.patient_name, name: "patient_name" },
        { text: v.doc_type, name: "doc_type" },
        { text: v.clinic_name, name: "clinic_name" },
      ];
      primaryPayload = `get_doc:${args.booking_id}`;
      break;
    default:
      throw new Error(`Unknown template: ${args.template_name}`);
  }

  return [
    {
      type: "body",
      parameters: bodyParams.map((p) => ({
        type: "text",
        text: p.text,
        parameter_name: p.name,
      })),
    },
    {
      type: "button",
      sub_type: "quick_reply",
      index: "0",
      parameters: [{ type: "payload", payload: primaryPayload }],
    },
    {
      type: "button",
      sub_type: "quick_reply",
      index: "1",
      parameters: [{ type: "payload", payload: `mute_clinic:${args.clinic_id}` }],
    },
  ];
}
