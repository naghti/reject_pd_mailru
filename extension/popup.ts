import { manualReasons, readyLetters } from "./readiness";
import data from "../src/generated/data.json";
import { makeLetter } from "../src/letters";
import type { Company, Mode, Profile } from "../src/types";
declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<{ value?: any; error?: string }>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, any>>;
      set(value: Record<string, unknown>): Promise<void>;
    };
  };
};
let prepared: import("../src/types").Letter[] = [];

const form = document.querySelector<HTMLFormElement>("#profile")!;
const status = document.querySelector<HTMLElement>("#status")!;
const companies = data.companies as Company[];
const selected = new Set<string>();
const list = document.querySelector("#companies")!;
for (const company of companies) {
  const label = document.createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.onchange = () => {
    if (checkbox.checked) selected.add(company.id);
    else selected.delete(company.id);
  };
  label.append(checkbox, document.createTextNode(" " + company.name));
  list.append(label);
}
document.querySelector<HTMLButtonElement>("#select-all")!.onclick = () => {
  for (const company of companies) selected.add(company.id);
  for (const checkbox of list.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  ))
    checkbox.checked = true;
  // Invalidate the previous preview and any pending send confirmation.
  form.dispatchEvent(new Event("input", { bubbles: true }));
  status.textContent = `Выбраны все компании: ${selected.size}. Подготовьте новый предпросмотр.`;
};
document.querySelector<HTMLInputElement>("#search")!.oninput = (event) => {
  const query = (event.target as HTMLInputElement).value.toLocaleLowerCase();
  for (const label of list.querySelectorAll("label"))
    label.hidden = !label.textContent!.toLocaleLowerCase().includes(query);
};
const input = (name: string) =>
  form.elements.namedItem(name) as HTMLInputElement;
input("date").value = new Date(
  Date.now() - new Date().getTimezoneOffset() * 60000,
)
  .toISOString()
  .slice(0, 10);
void chrome.storage.local
  .get("profile")
  .then(({ profile }) => {
    if (profile && typeof profile === "object")
      for (const key of ["fio", "email"]) {
        const value = (profile as Record<string, unknown>)[key];
        if (typeof value === "string") input(key).value = value;
      }
  })
  .catch(() => {
    status.textContent = "Не удалось загрузить профиль.";
  });
form.onsubmit = (event) => {
  event.preventDefault();
  prepared = [];
  const preview = document.querySelector("#preview")!;
  preview.replaceChildren();
  try {
    if (!selected.size) throw new Error("Выберите компании.");
    const profile: Profile = {
      fio: input("fio").value,
      email: input("email").value,
      date: input("date").value,
      inn: "",
      phone: "",
      series: "",
      number: "",
      issuer: "",
      city: "",
      issued: "",
    };
    const mode = input("mode").value as Mode;
    const letters = companies
      .filter((c) => selected.has(c.id))
      .map((c) =>
        makeLetter(
          c,
          profile,
          mode,
          data.templates[mode],
          input("interaction").value,
        ),
      );
    prepared = letters;
    for (const letter of letters) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      const reasons = manualReasons(letter);
      summary.textContent =
        letter.companyName +
        (reasons.length ? " — требуется действие" : " — готово");
      if (reasons.length) details.open = true;
      const text = document.createElement("pre");
      text.textContent = [
        "Кому: " + letter.to.join(", "),
        letter.subject,
        letter.body,
        ...letter.missing,
        ...letter.actions,
      ].join("\n\n");
      details.append(summary, text);
      preview.append(details);
    }
    void chrome.storage.local
      .set({ profile: { fio: profile.fio, email: profile.email } })
      .catch(() => {
        status.textContent = "Не удалось сохранить профиль.";
      });
    const ready = readyLetters(letters).length;
    status.textContent = `Готово к отправке: ${ready} из ${letters.length}. Требуют действий: ${letters.length - ready}. Проверьте предпросмотр.`;
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Не удалось подготовить письма.";
  }
};

form.addEventListener("input", () => {
  prepared = [];
});
const mailbox = document.querySelector<HTMLSelectElement>("#mailbox")!;
async function command(message: unknown) {
  const result = await chrome.runtime.sendMessage(message);
  if (result.error) throw Error(result.error);
  return result.value;
}
async function refreshSessions() {
  const sessions = await command({ type: "sessions" });
  const old = mailbox.value;
  mailbox.replaceChildren();
  for (const session of sessions) {
    const option = new Option(session.email, session.key);
    mailbox.add(option);
  }
  if ([...mailbox.options].some((o) => o.value === old)) mailbox.value = old;
  if (!sessions.length)
    mailbox.add(new Option("Обновите открытую вкладку Mail.ru", ""));
}
function action(id: string, run: () => Promise<void>) {
  document.querySelector<HTMLButtonElement>(id)!.onclick = () => {
    const button = document.querySelector<HTMLButtonElement>(id)!;
    if (button.disabled) return;
    button.disabled = true;
    void run()
      .catch((e) => {
        status.textContent = e.message;
      })
      .finally(() => {
        button.disabled = false;
      });
  };
}
action("#connect", refreshSessions);
action("#send", async () => {
  if (!prepared.length) throw Error("Сначала подготовьте предпросмотр.");
  if (!mailbox.value) throw Error("Обновите вкладку почты и список ящиков.");
  const ready = readyLetters(prepared).length;
  if (!ready)
    throw Error(
      "Нет готовых писем. В предпросмотре указано, что нужно заполнить или приложить.",
    );
  pending = { key: mailbox.value, letters: structuredClone(prepared) };
  confirmationText.textContent = `Отправить ${ready} писем с ${mailbox.selectedOptions[0].text}? Требуют действий и не будут отправлены: ${prepared.length - ready}.`;
  confirmation.hidden = false;
  document.querySelector<HTMLButtonElement>("#confirm-send")!.focus();
});
const confirmation = document.querySelector<HTMLElement>("#confirmation")!;
const confirmationText =
  document.querySelector<HTMLElement>("#confirmation-text")!;
let pending: { key: string; letters: typeof prepared } | null = null;
function cancelConfirmation() {
  pending = null;
  confirmation.hidden = true;
}
action("#cancel-send", async () => {
  cancelConfirmation();
});
mailbox.addEventListener("change", cancelConfirmation);
form.addEventListener("input", cancelConfirmation);
form.addEventListener("submit", cancelConfirmation);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") cancelConfirmation();
});
action("#confirm-send", async () => {
  const batch = pending;
  if (!batch) return;
  cancelConfirmation();
  await command({ type: "start", key: batch.key, letters: batch.letters });
  prepared = [];
  status.textContent =
    "Очередь запущена. Окно расширения можно закрыть, вкладку почты оставьте открытой.";
  await refreshQueue();
});
action("#stop", async () => {
  await command({ type: "stop" });
  await refreshQueue();
});
action("#resume", async () => {
  await command({ type: "resume", key: mailbox.value });
  await refreshQueue();
});
async function refreshQueue() {
  const { queue } = await chrome.storage.local.get("queue");
  const box = document.querySelector("#queue")!;
  box.replaceChildren();
  if (!queue) return;
  const title = document.createElement("p");
  title.textContent = `${queue.email}: ${queue.running ? "Отправка" : "Остановлено"} · ${queue.items.filter((i: any) => i.status === "sent").length} / ${queue.items.filter((i: any) => i.status !== "manual").length} (требуют действий: ${queue.items.filter((i: any) => i.status === "manual").length})`;
  box.append(title);
  if (queue.error) {
    const p = document.createElement("p");
    p.textContent = queue.error;
    box.append(p);
  }
  const labels: Record<string, string> = {
    manual: "Требуется действие",
    queued: "В очереди",
    sending: "Отправляется",
    sent: "Принято Mail.ru",
    uncertain: "Не подтверждено — проверьте почту",
  };
  for (const item of queue.items) {
    const row = document.createElement("p");
    row.textContent =
      item.letter.companyName +
      ": " +
      labels[item.status] +
      (item.reasons?.length ? " — " + item.reasons.join("; ") : "");
    box.append(row);
  }
}
void refreshSessions().catch(() => {
  status.textContent = "Не удалось подключиться к расширению.";
});
let refreshing = false;
async function pollQueue() {
  if (refreshing) return;
  refreshing = true;
  try {
    await refreshQueue();
  } catch {
    status.textContent = "Не удалось обновить статус очереди.";
  } finally {
    refreshing = false;
  }
}
void pollQueue();
setInterval(() => void pollQueue(), 1500);
