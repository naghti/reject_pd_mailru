import type { Letter } from "../src/types";
export function sendFields(
  letter: Pick<Letter, "to" | "subject" | "body">,
  email: string,
  token: string,
  id: string,
) {
  if (
    !letter.to.length ||
    letter.to.some((e) => !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(e)) ||
    /[\r\n]/.test(letter.subject)
  )
    throw new Error("Некорректные получатели или тема");
  const html =
    "<div>" +
    letter.body
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>") +
    "</div>";
  return new URLSearchParams({
    SYNC_ADD_FORWARD_ATTACHMENTS: "false",
    ATTACHMENTS_RESTORE: "true",
    ATTACHMENTS_EXPIRATION_TIME: "14400000",
    id,
    source: JSON.stringify({ draft: "", reply: "", forward: "", schedule: "" }),
    headers: "{}",
    template: "0",
    sign: "0",
    remind: "0",
    delivery_report: "false",
    receipt: "false",
    subject: letter.subject,
    priority: "3",
    send_date: "",
    body: JSON.stringify({ html, text: letter.body }),
    from: email,
    correspondents: JSON.stringify({
      to: letter.to.join(", "),
      cc: "",
      bcc: "",
      reply_to: "",
    }),
    folder_id: "",
    triggerModelChangePlease: "true",
    delay_for_cancellation: "false",
    attaches: JSON.stringify({ list: [] }),
    email,
    htmlencoded: "false",
    token,
  }).toString();
}
export function acknowledged(value: unknown): boolean {
  const v = value as { status?: number; body?: { id?: unknown } } | null;
  return (
    v?.status === 200 && typeof v.body?.id === "string" && v.body.id.length > 0
  );
}
