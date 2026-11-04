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
      summary.textContent = letter.companyName;
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
    status.textContent = `Подготовлено: ${letters.length}. Проверьте тексты, затем нажмите «Отправить подготовленные».`;
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
    void run().catch((e) => {
      status.textContent = e.message;
    });
  };
}
action("#connect", refreshSessions);
action("#send", async () => {
  if (!prepared.length) throw Error("Сначала подготовьте предпросмотр.");
  if (!mailbox.value) throw Error("Обновите вкладку почты и список ящиков.");
  if (
    !confirm(
      `Отправить ${prepared.length} писем с ${mailbox.selectedOptions[0].text}?`,
    )
  )
    return;
  await command({ type: "start", key: mailbox.value, letters: prepared });
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
  title.textContent = `${queue.email}: ${queue.running ? "Отправка" : "Остановлено"} · ${queue.items.filter((i: any) => i.status === "sent").length} / ${queue.items.length}`;
  box.append(title);
  if (queue.error) {
    const p = document.createElement("p");
    p.textContent = queue.error;
    box.append(p);
  }
  const labels: Record<string, string> = {
    queued: "В очереди",
    sending: "Отправляется",
    sent: "Принято Mail.ru",
    uncertain: "Не подтверждено — проверьте почту",
  };
  for (const item of queue.items) {
    const row = document.createElement("p");
    row.textContent = item.letter.companyName + ": " + labels[item.status];
    box.append(row);
  }
}
void refreshSessions().catch(() => {
  status.textContent = "Не удалось подключиться к расширению.";
});
void refreshQueue();
setInterval(() => void refreshQueue(), 1500);
