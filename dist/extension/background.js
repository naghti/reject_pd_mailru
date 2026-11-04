"use strict";
(() => {
  // extension/diagnostics.ts
  var codes = /* @__PURE__ */ new Set([
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
    "failed"
  ]);
  function code(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return typeof value === "string" && codes.has(value.toLowerCase()) ? value.toLowerCase() : null;
  }
  function responseSummary(response) {
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
      "source.draft"
    ];
    const errors = {};
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
      stage: ["network", "timeout", "parse", "response"].includes(response?.stage) ? response.stage : "no_result",
      redirected: response?.redirected === true,
      durationMs: typeof response?.durationMs === "number" ? response.durationMs : null
    };
  }
  function executionFailure(error) {
    const message = String(error?.message || "");
    if (/No frame|frame.*removed|frame.*not found/i.test(message))
      return "frame_missing";
    if (/No tab|tab.*closed/i.test(message)) return "tab_closed";
    if (/Cannot access|permission|not allowed/i.test(message))
      return "permission_denied";
    return "script_execution_failed";
  }

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

  // extension/readiness.ts
  function manualReasons(letter) {
    return [
      ...letter.missing.map((field) => `\u0417\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u0435: ${field}`),
      ...letter.actions
    ];
  }
  function readyLetters(letters) {
    return letters.filter((letter) => manualReasons(letter).length === 0);
  }

  // extension/background.js
  var sessions = /* @__PURE__ */ new Map();
  var logWrite = Promise.resolve();
  function log(event, detail = {}) {
    logWrite = logWrite.then(async () => {
      const { diagnostics = [] } = await chrome.storage.local.get("diagnostics");
      await chrome.storage.local.set({
        diagnostics: [
          ...diagnostics.slice(-199),
          { time: (/* @__PURE__ */ new Date()).toISOString(), event, ...detail }
        ]
      });
    }).catch(() => {
    });
    return logWrite;
  }
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
          frameId: details.frameId,
          capturedAt: Date.now()
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
        await log("interrupted_attempt", { index: queue.items.indexOf(item) });
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
        await log("session_unavailable");
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
      await log("send_prepared", {
        index: queue.items.indexOf(next),
        tabId: session.tabId,
        frameId: session.frameId,
        recipients: next.letter.to.length,
        tokenPresent: !!session.token,
        sessionAgeMs: session.capturedAt ? Date.now() - session.capturedAt : null
      });
      next.status = "sending";
      await chrome.storage.local.set({ queue });
      try {
        const result = await chrome.scripting.executeScript({
          target: { tabId: session.tabId, frameIds: [session.frameId] },
          func: async (body) => {
            const started = Date.now();
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
              let data;
              try {
                data = await response2.json();
              } catch {
                return {
                  http: response2.status,
                  stage: "parse",
                  redirected: response2.redirected,
                  durationMs: Date.now() - started
                };
              }
              return {
                http: response2.status,
                data,
                stage: "response",
                redirected: response2.redirected,
                durationMs: Date.now() - started
              };
            } catch (error) {
              return {
                stage: error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "network",
                durationMs: Date.now() - started
              };
            }
          },
          args: [payload]
        });
        const response = result[0]?.result;
        next.diagnostic = responseSummary(response);
        await log("send_response", {
          index: queue.items.indexOf(next),
          ...next.diagnostic
        });
        next.status = response?.http === 200 && acknowledged(response.data) ? "sent" : "uncertain";
      } catch (error) {
        next.diagnostic = { stage: executionFailure(error) };
        await log("send_execution_error", {
          index: queue.items.indexOf(next),
          ...next.diagnostic
        });
        next.status = "uncertain";
      }
      const latest = (await chrome.storage.local.get("queue")).queue;
      queue.running = !!latest?.running && next.status === "sent";
      if (next.status === "uncertain")
        queue.error = `\u041E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u043D\u0435 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0430. \u042D\u0442\u0430\u043F: ${next.diagnostic?.stage || "unknown"}; HTTP: ${next.diagnostic?.http ?? "\u043D\u0435\u0442"}; API: ${next.diagnostic?.apiStatus ?? "\u043D\u0435\u0442"}. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \xAB\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u044B\u0435\xBB. \u0421\u043A\u0430\u0447\u0430\u0439\u0442\u0435 \u0436\u0443\u0440\u043D\u0430\u043B \u0434\u0438\u0430\u0433\u043D\u043E\u0441\u0442\u0438\u043A\u0438. \u0410\u0432\u0442\u043E\u043F\u043E\u0432\u0442\u043E\u0440 \u043E\u0442\u043A\u043B\u044E\u0447\u0451\u043D.`;
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
      if (message.type === "diagnostics") {
        await logWrite;
        const { diagnostics = [], queue } = await chrome.storage.local.get([
          "diagnostics",
          "queue"
        ]);
        return {
          version: "0.4.4",
          events: diagnostics,
          queue: queue ? {
            running: queue.running,
            statuses: queue.items.map((i) => i.status)
          } : null
        };
      }
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
          if (!readyLetters(message.letters).length)
            throw Error("\u041D\u0435\u0442 \u0433\u043E\u0442\u043E\u0432\u044B\u0445 \u043F\u0438\u0441\u0435\u043C. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u043F\u0440\u0438\u0447\u0438\u043D\u044B \u0432 \u043F\u0440\u0435\u0434\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440\u0435.");
          const items = message.letters.map((letter) => {
            const reasons = manualReasons(letter);
            if (reasons.length) return { letter, status: "manual", reasons };
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
          await log("queue_started", {
            total: items.length,
            ready: items.filter((i) => i.status === "queued").length
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
