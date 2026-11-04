import { test } from "node:test";
import assert from "node:assert/strict";
import { sendFields, acknowledged } from "../extension/api";
test("API form preserves Unicode, all recipients and escapes HTML", () => {
  const p = new URLSearchParams(
    sendFields(
      {
        to: ["first@example.org", "second@example.org"],
        subject: "Тема & тест",
        body: "Текст <tag>\nСтрока",
      },
      "me@example.org",
      "secret",
      "fresh-id",
    ),
  );
  assert.equal(p.get("subject"), "Тема & тест");
  assert.deepEqual(JSON.parse(p.get("correspondents")!), {
    to: "first@example.org, second@example.org",
    cc: "",
    bcc: "",
    reply_to: "",
  });
  assert.equal(
    JSON.parse(p.get("body")!).html,
    "<div>Текст &lt;tag&gt;<br>Строка</div>",
  );
  assert.equal(p.get("delay_for_cancellation"), "false");
  assert.equal(p.get("token"), "secret");
  assert.deepEqual(JSON.parse(p.get("source")!), {
    draft: "",
    reply: "",
    forward: "",
    schedule: "",
  });
});
test("Only API success with message ID acknowledges submission", () => {
  assert.equal(
    acknowledged({ status: 200, body: { id: "new-message" } }),
    true,
  );
  for (const value of [
    null,
    {},
    { status: 200, body: {} },
    { status: 403, body: { id: "x" } },
    { status: 200, body: { id: "" } },
  ])
    assert.equal(acknowledged(value), false);
});
test("Invalid addresses and header newlines rejected before submission", () => {
  for (const letter of [
    { to: [], subject: "test", body: "test" },
    { to: ["a@example.org"], subject: "bad\r\nheader", body: "test" },
  ])
    assert.throws(() => sendFields(letter, "me@example.org", "secret", "id"));
});
