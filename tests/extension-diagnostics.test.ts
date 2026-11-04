import { test } from "node:test";
import assert from "node:assert/strict";
import { responseSummary, executionFailure } from "../extension/diagnostics";
test("Response logging is an allowlist, not a dump of server data", () => {
  const report = responseSummary({
    http: 400,
    stage: "response",
    data: {
      status: 400,
      email: "private@example.org",
      token: "secret-token",
      error: {
        code: "invalid_token",
        message: "private@example.org secret-token",
      },
      body: {
        id: "secret-message-id",
        subject: { error: "invalid", value: "private body" },
        from: { error: "private@example.org" },
      },
    },
  });
  assert.equal(report.errorCode, "invalid_token");
  assert.equal(report.fieldErrors.subject, "invalid");
  assert.equal(report.fieldErrors.from, "unrecognized_error");
  for (const secret of [
    "private@example.org",
    "secret-token",
    "secret-message-id",
    "private body",
  ])
    assert.ok(!JSON.stringify(report).includes(secret));
});
test("Execution exceptions are reduced to static diagnostic categories", () => {
  assert.equal(
    executionFailure(new Error("No frame with id 2 in tab 1")),
    "frame_missing",
  );
  assert.equal(
    executionFailure(
      new Error(
        "Cannot access contents of url https://private.example/?token=secret",
      ),
    ),
    "permission_denied",
  );
  assert.equal(
    executionFailure(new Error("anything secret")),
    "script_execution_failed",
  );
});
test("Network, timeout and invalid JSON remain distinguishable", () => {
  for (const stage of ["network", "timeout", "parse"])
    assert.equal(responseSummary({ stage, http: 502 }).stage, stage);
  assert.equal(responseSummary(null).stage, "no_result");
});
