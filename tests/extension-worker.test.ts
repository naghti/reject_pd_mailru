import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";
const bundle = await build({
  entryPoints: ["extension/background.js"],
  bundle: true,
  write: false,
  format: "iife",
  target: "chrome120",
});
async function harness(response: unknown, initial?: unknown) {
  const data: any = { queue: initial };
  const handlers: any = {};
  let calls = 0;
  const alarms: any[] = [];
  const local = {
    get: async (key: string) => structuredClone({ [key]: data[key] }),
    set: async (value: any) => Object.assign(data, structuredClone(value)),
  };
  const chrome = {
    storage: { local, session: { get: async () => ({}), set: async () => {} } },
    runtime: {
      id: "test",
      onMessage: { addListener: (f: any) => (handlers.message = f) },
    },
    webRequest: {
      onBeforeRequest: { addListener: (f: any) => (handlers.request = f) },
    },
    alarms: {
      create: async (...a: any[]) => alarms.push(a),
      onAlarm: { addListener: (f: any) => (handlers.alarm = f) },
    },
    scripting: {
      executeScript: async () => {
        calls++;
        return [{ result: response }];
      },
    },
  };
  vm.runInNewContext(bundle.outputFiles[0].text, {
    chrome,
    URL,
    URLSearchParams,
    TextDecoder,
    crypto,
    AbortSignal,
    console,
  });
  handlers.request({
    tabId: 1,
    frameId: 2,
    url: "https://e.mail.ru/api/v1/aliases?email=me%40example.org&token=test",
  });
  const message = (m: any) =>
    new Promise<any>((resolve) => handlers.message(m, { id: "test" }, resolve));
  const settle = async () => {
    for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r));
  };
  return { data, message, settle, alarms, calls: () => calls };
}
const letter = {
  to: ["a@example.org"],
  subject: "Тема",
  body: "Текст",
  companyName: "Тест",
  missing: [],
  actions: [],
};
test("Worker records success and schedules next item without UI", async () => {
  const h = await harness({
    http: 200,
    data: { status: 200, body: { id: "sent-id" } },
  });
  await h.message({ type: "start", key: "1:2", letters: [letter, letter] });
  await h.settle();
  assert.equal(h.data.queue.items[0].status, "sent");
  assert.equal(h.data.queue.items[1].status, "queued");
  assert.equal(h.calls(), 1);
  assert.equal(h.alarms.length, 1);
});
test("Unknown result stops queue and resume skips attempted letter", async () => {
  const h = await harness(null);
  await h.message({ type: "start", key: "1:2", letters: [letter] });
  await h.settle();
  assert.equal(h.data.queue.items[0].status, "uncertain");
  assert.equal(h.data.queue.running, false);
  await h.message({ type: "resume", key: "1:2" });
  await h.settle();
  assert.equal(h.calls(), 1);
});
test("Restarted in-flight job becomes uncertain without retry", async () => {
  const h = await harness(null, {
    email: "me@example.org",
    sessionKey: "1:2",
    running: false,
    items: [{ letter, status: "sending" }],
  });
  await h.message({ type: "resume", key: "1:2" });
  await h.settle();
  assert.equal(h.calls(), 0);
  assert.equal(h.data.queue.items[0].status, "uncertain");
});

test("One manual letter does not block other ready letters and is retained with reasons", async () => {
  const h = await harness({
    http: 200,
    data: { status: 200, body: { id: "sent-id" } },
  });
  const manual = {
    ...letter,
    companyName: "Нужен PDF",
    actions: ["Приложите PDF"],
  };
  const result = await h.message({
    type: "start",
    key: "1:2",
    letters: [manual, letter],
  });
  assert.equal(result.error, undefined);
  await h.settle();
  assert.equal(h.calls(), 1);
  assert.equal(h.data.queue.items[0].status, "manual");
  assert.deepEqual(Array.from(h.data.queue.items[0].reasons), [
    "Приложите PDF",
  ]);
  assert.equal(h.data.queue.items[1].status, "sent");
});
test("Entirely incomplete batch never creates a queue or sends", async () => {
  const h = await harness(null);
  const result = await h.message({
    type: "start",
    key: "1:2",
    letters: [{ ...letter, missing: ["Сведения о взаимодействии"] }],
  });
  assert.match(result.error, /Нет готовых/);
  await h.settle();
  assert.equal(h.calls(), 0);
  assert.equal(h.data.queue, undefined);
});
