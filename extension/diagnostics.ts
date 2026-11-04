const codes = new Set([
  "invalid",
  "required",
  "auth",
  "unauthorized",
  "forbidden",
  "invalid_token",
  "token_expired",
  "access_denied",
  "captcha",
  "limit",
  "limited",
  "rate_limit",
  "not_found",
  "internal_error",
  "illegal_params",
  "ok",
  "error",
  "fail",
  "failed",
]);
function code(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return typeof value === "string" && codes.has(value.toLowerCase())
    ? value.toLowerCase()
    : null;
}
export function responseSummary(response: any) {
  const data = response?.data;
  const fields = [
    "from",
    "email",
    "token",
    "body",
    "subject",
    "correspondents",
    "attaches",
    "id",
    "source",
    "source.draft",
  ];
  const errors: Record<string, unknown> = {};
  for (const field of fields) {
    const v = data?.body?.[field];
    if (v && typeof v === "object" && "error" in v)
      errors[field] = code(v.error) ?? "unrecognized_error";
  }
  return {
    http: typeof response?.http === "number" ? response.http : null,
    apiStatus: code(data?.status),
    hasMessageId: typeof data?.body?.id === "string" && data.body.id.length > 0,
    hasError: !!data?.error,
    errorCode: code(data?.error?.code) ?? code(data?.error) ?? code(data?.code),
    fieldErrors: errors,
    json: !!data && typeof data === "object",
    stage: ["network", "timeout", "parse", "response"].includes(response?.stage)
      ? response.stage
      : "no_result",
    redirected: response?.redirected === true,
    durationMs:
      typeof response?.durationMs === "number" ? response.durationMs : null,
  };
}
export function executionFailure(error: unknown) {
  const message = String((error as any)?.message || "");
  if (/No frame|frame.*removed|frame.*not found/i.test(message))
    return "frame_missing";
  if (/No tab|tab.*closed/i.test(message)) return "tab_closed";
  if (/Cannot access|permission|not allowed/i.test(message))
    return "permission_denied";
  return "script_execution_failed";
}
