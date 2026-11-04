"use strict";
(() => {
  // extension/api.ts
  function sendFields(letter, email, token, id) {
    if (!letter.to.length || letter.to.some((e) => !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(e)) || /[\r\n]/.test(letter.subject))
      throw new Error("\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0435 \u043F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u0438 \u0438\u043B\u0438 \u0442\u0435\u043C\u0430");
    const html = "<div>" + letter.body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>") + "</div>";
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
        reply_to: ""
      }),
      folder_id: "",
      triggerModelChangePlease: "true",
      delay_for_cancellation: "false",
      attaches: JSON.stringify({ list: [] }),
      email,
      htmlencoded: "false",
      token
    }).toString();
  }
  function acknowledged(value) {
    const v = value;
    return v?.status === 200 && typeof v.body?.id === "string" && v.body.id.length > 0;
  }

  // extension/background.js
  var sessions = /* @__PURE__ */ new Map();
  var loaded = chrome.storage.session.get("sessions").then((v) => {
    for (const [key, value] of v.sessions || [])
      if (!sessions.has(key)) sessions.set(key, value);
  });
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return;
      const url = new URL(details.url);
      const fields = new URLSearchParams(url.search);
      const form = details.requestBody?.formData;
      if (form) {
        for (const key of ["email", "token"])
          if (form[key]?.[0]) fields.set(key, form[key][0]);
      }
      if (details.requestBody?.raw)
        try {
          const raw = details.requestBody.raw.map((p) => p.bytes ? new TextDecoder().decode(p.bytes) : "").join("");
          const parsed = new URLSearchParams(raw);
          for (const key of ["email", "token"])
            if (parsed.has(key)) fields.set(key, parsed.get(key));
        } catch {
        }
      const email = fields.get("email"), token = fields.get("token");
      if (email && token) {
        sessions.set(`${details.tabId}:${details.frameId}`, {
          email,
          token,
          tabId: details.tabId,
          frameId: details.frameId
        });
        void loaded.then(
          () => chrome.storage.session.set({ sessions: [...sessions.entries()] })
        );
      }
    },
    { urls: ["https://e.mail.ru/api/*"] },
    ["requestBody"]
  );
  var busy = false;
  var commandBusy = false;
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
        queue.error = "\u041F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0430\u044F \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u043D\u0435 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0430. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \xAB\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u044B\u0435\xBB.";
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
        queue.error = "\u0421\u0435\u0441\u0441\u0438\u044F \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430. \u041E\u0431\u043D\u043E\u0432\u0438\u0442\u0435 \u0432\u043A\u043B\u0430\u0434\u043A\u0443 \u043F\u043E\u0447\u0442\u044B \u0438 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB\u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C\xBB.";
        await chrome.storage.local.set({ queue });
        return;
      }
      const payload = sendFields(
        next.letter,
        session.email,
        session.token,
        crypto.randomUUID().replaceAll("-", "")
      );
      next.status = "sending";
      await chrome.storage.local.set({ queue });
      try {
        const result = await chrome.scripting.executeScript({
          target: { tabId: session.tabId, frameIds: [session.frameId] },
          func: async (body) => {
            try {
              const response2 = await fetch(
                "https://e.mail.ru/api/v1/messages/send",
                {
                  method: "POST",
                  credentials: "include",
                  headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                  },
                  body,
                  signal: AbortSignal.timeout(2e4)
                }
              );
              return { http: response2.status, data: await response2.json() };
            } catch {
              return null;
            }
          },
          args: [payload]
        });
        const response = result[0]?.result;
        next.status = response?.http === 200 && acknowledged(response.data) ? "sent" : "uncertain";
      } catch {
        next.status = "uncertain";
      }
      const latest = (await chrome.storage.local.get("queue")).queue;
      queue.running = !!latest?.running && next.status === "sent";
      if (next.status === "uncertain")
        queue.error = "\u041E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u043D\u0435 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0430. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \xAB\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u044B\u0435\xBB. \u0410\u0432\u0442\u043E\u043F\u043E\u0432\u0442\u043E\u0440 \u043E\u0442\u043A\u043B\u044E\u0447\u0451\u043D.";
      await chrome.storage.local.set({ queue });
      if (queue.running)
        await chrome.alarms.create("send-next", { when: Date.now() + 5e3 });
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
          email: s.email
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
        if (commandBusy) throw Error("\u041A\u043E\u043C\u0430\u043D\u0434\u0430 \u0443\u0436\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u044F\u0435\u0442\u0441\u044F");
        commandBusy = true;
        try {
          if (busy) throw Error("\u041E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u0443\u0436\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u044F\u0435\u0442\u0441\u044F");
          const old = (await chrome.storage.local.get("queue")).queue;
          if (old?.running) throw Error("\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u0435 \u0442\u0435\u043A\u0443\u0449\u0443\u044E \u043E\u0447\u0435\u0440\u0435\u0434\u044C");
          if (!Array.isArray(message.letters) || !message.letters.length)
            throw Error("\u041D\u0435\u0442 \u043F\u0438\u0441\u0435\u043C");
          const s = sessions.get(message.key);
          if (!s) throw Error("\u041E\u0431\u043D\u043E\u0432\u0438\u0442\u0435 \u0432\u043A\u043B\u0430\u0434\u043A\u0443 \u043F\u043E\u0447\u0442\u044B");
          const items = message.letters.map((letter) => {
            if (letter.missing.length || letter.actions.length)
              throw Error(
                "\u0415\u0441\u0442\u044C \u043F\u0438\u0441\u044C\u043C\u0430 \u0441 \u043D\u0435\u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u043D\u044B\u043C\u0438 \u043F\u043E\u043B\u044F\u043C\u0438 \u0438\u043B\u0438 \u0434\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u043C\u0438 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F\u043C\u0438"
              );
            sendFields(letter, s.email, s.token, "validation");
            return { letter, status: "queued" };
          });
          await chrome.storage.local.set({
            queue: {
              email: s.email,
              sessionKey: message.key,
              running: true,
              items
            }
          });
          void tick();
          return true;
        } finally {
          commandBusy = false;
        }
      }
      if (message.type === "resume") {
        if (busy) throw Error("\u0414\u043E\u0436\u0434\u0438\u0442\u0435\u0441\u044C \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0437\u0430\u043F\u0440\u043E\u0441\u0430");
        const { queue } = await chrome.storage.local.get("queue");
        const s = sessions.get(message.key);
        if (!queue || !s || s.email !== queue.email)
          throw Error("\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0442\u043E\u0442 \u0436\u0435 \u043F\u043E\u0447\u0442\u043E\u0432\u044B\u0439 \u044F\u0449\u0438\u043A");
        queue.sessionKey = message.key;
        queue.running = true;
        queue.error = "";
        await chrome.storage.local.set({ queue });
        void tick();
        return true;
      }
    })().then(
      (value) => reply({ value }),
      (e) => reply({ error: e.message })
    );
    return true;
  });
})();
