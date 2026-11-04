import { sendFields, acknowledged } from "./api.ts";
// Secrets use browser-session memory, never persistent queue history.
const sessions = new Map();
const loaded = chrome.storage.session.get("sessions").then((v) => {
  for (const [key, value] of v.sessions || [])
    if (!sessions.has(key)) sessions.set(key, value);
});
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = new URL(details.url);
    const fields = new URLSearchParams(url.search);
    const form = details.requestBody?.formData;
    if (form)
      for (const key of ["email", "token"])
        if (form[key]?.[0]) fields.set(key, form[key][0]);
    if (details.requestBody?.raw)
      try {
        const raw = details.requestBody.raw
          .map((p) => (p.bytes ? new TextDecoder().decode(p.bytes) : ""))
          .join("");
        const parsed = new URLSearchParams(raw);
        for (const key of ["email", "token"])
          if (parsed.has(key)) fields.set(key, parsed.get(key));
      } catch {}
    const email = fields.get("email"),
      token = fields.get("token");
    if (email && token) {
      sessions.set(`${details.tabId}:${details.frameId}`, {
        email,
        token,
        tabId: details.tabId,
        frameId: details.frameId,
      });
      void loaded.then(() =>
        chrome.storage.session.set({ sessions: [...sessions.entries()] }),
      );
    }
  },
  { urls: ["https://e.mail.ru/api/*"] },
  ["requestBody"],
);
let busy = false;
let commandBusy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    await loaded;
    const { queue } = await chrome.storage.local.get("queue");
    if (!queue?.running) return;
    const item = queue.items.find((i) => i.status === "sending");
    if (item) {
      item.status = "uncertain";
      queue.running = false;
      queue.error =
        "Предыдущая отправка не подтверждена. Проверьте «Отправленные».";
      await chrome.storage.local.set({ queue });
      return;
    }
    const next = queue.items.find((i) => i.status === "queued");
    if (!next) {
      queue.running = false;
      await chrome.storage.local.set({ queue });
      return;
    }
    const session = sessions.get(queue.sessionKey);
    if (!session || session.email !== queue.email) {
      queue.running = false;
      queue.error =
        "Сессия недоступна. Обновите вкладку почты и нажмите «Продолжить».";
      await chrome.storage.local.set({ queue });
      return;
    }
    const payload = sendFields(
      next.letter,
      session.email,
      session.token,
      crypto.randomUUID().replaceAll("-", ""),
    );
    next.status = "sending";
    await chrome.storage.local.set({ queue });
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: session.tabId, frameIds: [session.frameId] },
        func: async (body) => {
          try {
            const response = await fetch(
              "https://e.mail.ru/api/v1/messages/send",
              {
                method: "POST",
                credentials: "include",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body,
                signal: AbortSignal.timeout(20000),
              },
            );
            return { http: response.status, data: await response.json() };
          } catch {
            return null;
          }
        },
        args: [payload],
      });
      const response = result[0]?.result;
      next.status =
        response?.http === 200 && acknowledged(response.data)
          ? "sent"
          : "uncertain";
    } catch {
      next.status = "uncertain";
    }
    // Honour Stop pressed while the request was in flight.
    const latest = (await chrome.storage.local.get("queue")).queue;
    queue.running = !!latest?.running && next.status === "sent";
    if (next.status === "uncertain")
      queue.error =
        "Отправка не подтверждена. Проверьте «Отправленные». Автоповтор отключён.";
    await chrome.storage.local.set({ queue });
    if (queue.running)
      await chrome.alarms.create("send-next", { when: Date.now() + 5000 });
  } finally {
    busy = false;
  }
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "send-next") void tick();
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  (async () => {
    await loaded;
    if (message.type === "sessions")
      return [...sessions.entries()].map(([key, s]) => ({
        key,
        email: s.email,
      }));
    if (message.type === "stop") {
      const { queue } = await chrome.storage.local.get("queue");
      if (queue) {
        queue.running = false;
        await chrome.storage.local.set({ queue });
      }
      return true;
    }
    if (message.type === "start") {
      if (commandBusy) throw Error("Команда уже выполняется");
      commandBusy = true;
      try {
        if (busy) throw Error("Отправка уже выполняется");
        const old = (await chrome.storage.local.get("queue")).queue;
        if (old?.running) throw Error("Сначала остановите текущую очередь");
        if (!Array.isArray(message.letters) || !message.letters.length)
          throw Error("Нет писем");
        const s = sessions.get(message.key);
        if (!s) throw Error("Обновите вкладку почты");
        const items = message.letters.map((letter) => {
          if (letter.missing.length || letter.actions.length)
            throw Error(
              "Есть письма с незаполненными полями или дополнительными действиями",
            );
          sendFields(letter, s.email, s.token, "validation");
          return { letter, status: "queued" };
        });
        await chrome.storage.local.set({
          queue: {
            email: s.email,
            sessionKey: message.key,
            running: true,
            items,
          },
        });
        void tick();
        return true;
      } finally {
        commandBusy = false;
      }
    }
    if (message.type === "resume") {
      if (busy) throw Error("Дождитесь текущего запроса");
      const { queue } = await chrome.storage.local.get("queue");
      const s = sessions.get(message.key);
      if (!queue || !s || s.email !== queue.email)
        throw Error("Выберите тот же почтовый ящик");
      queue.sessionKey = message.key;
      queue.running = true;
      queue.error = "";
      await chrome.storage.local.set({ queue });
      void tick();
      return true;
    }
  })().then(
    (value) => reply({ value }),
    (e) => reply({ error: e.message }),
  );
  return true;
});
