import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
const bundle = await build({
  entryPoints: ["extension/popup.ts"],
  bundle: true,
  write: false,
  format: "iife",
});
async function fixture() {
  const dom = new JSDOM(readFileSync("extension/popup.html", "utf8"), {
    runScripts: "outside-only",
  });
  const messages: any[] = [];
  let dialogs = 0;
  Object.assign(dom.window, {
    structuredClone,
    confirm: () => {
      dialogs++;
      throw Error("Blocking dialog forbidden");
    },
    chrome: {
      runtime: {
        sendMessage: async (m: any) => {
          messages.push(m);
          return {
            value:
              m.type === "sessions"
                ? [{ key: "1:2", email: "sender@example.org" }]
                : true,
          };
        },
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
  });
  dom.window.eval(bundle.outputFiles[0].text);
  const settle = async () => {
    await new Promise((r) => setImmediate(r));
  };
  await settle();
  const d = dom.window.document;
  for (const [name, value] of [
    ["fio", "Тест"],
    ["email", "reply@example.org"],
  ])
    (d.querySelector(`[name=${name}]`) as HTMLInputElement).value = value;
  const check = d.querySelector("#companies input") as HTMLInputElement;
  check.checked = true;
  check.dispatchEvent(new dom.window.Event("change"));
  d.querySelector("form")!.dispatchEvent(
    new dom.window.Event("submit", { cancelable: true }),
  );
  const click = (id: string) =>
    (d.querySelector(id) as HTMLButtonElement).click();
  return { dom, d, messages, settle, click, dialogs: () => dialogs };
}
test("Send opens inline confirmation without dialog or start; confirming twice submits once", async () => {
  const f = await fixture();
  try {
    f.click("#send");
    await f.settle();
    assert.equal(f.dialogs(), 0);
    assert.equal(f.messages.filter((m) => m.type === "start").length, 0);
    assert.equal(
      (f.d.querySelector("#confirmation") as HTMLElement).hidden,
      false,
    );
    assert.match(
      f.d.querySelector("#confirmation-text")!.textContent!,
      /sender@example.org/,
    );
    f.click("#confirm-send");
    f.click("#confirm-send");
    await f.settle();
    assert.equal(f.messages.filter((m) => m.type === "start").length, 1);
  } finally {
    f.dom.window.close();
  }
});
test("Cancel and Escape dismiss without sending; edits invalidate confirmation", async () => {
  const f = await fixture();
  try {
    f.click("#send");
    await f.settle();
    f.click("#cancel-send");
    await f.settle();
    f.click("#confirm-send");
    await f.settle();
    assert.equal(f.messages.filter((m) => m.type === "start").length, 0);
    f.click("#send");
    await f.settle();
    f.d.dispatchEvent(
      new f.dom.window.KeyboardEvent("keydown", { key: "Escape" }),
    );
    assert.equal(
      (f.d.querySelector("#confirmation") as HTMLElement).hidden,
      true,
    );
    f.click("#send");
    await f.settle();
    f.d
      .querySelector("[name=fio]")!
      .dispatchEvent(new f.dom.window.Event("input", { bubbles: true }));
    f.click("#confirm-send");
    await f.settle();
    assert.equal(f.messages.filter((m) => m.type === "start").length, 0);
  } finally {
    f.dom.window.close();
  }
});
