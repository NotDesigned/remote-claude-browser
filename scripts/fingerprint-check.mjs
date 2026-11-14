// Opens several browser accounts on an E2E gateway and reports what fingerprinting sites see in each:
// who.1ms.dog's fingerprint id, hardware id, grade and tells, and fingerprint.com's bot verdict.
// Accounts must come out with different ids and no bot or tampering verdict.
// Usage: node scripts/fingerprint-check.mjs <gateway base URL> [accounts=3]
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
const WebSocket = require("ws");
const [base = "http://127.0.0.1:3910", count = "3"] = process.argv.slice(2);
const owner = "fingerprint-check";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-mirror-e2e-owner": owner },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  if (!r.ok) throw Error(`${path}: ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function openAccount(index) {
  const session = await api("/api/client/session", { clientKey: `fingerprint-check-${index}` });
  const account = await api("/api/accounts", { name: `Fingerprint check ${index}` });
  await api(`/api/client/session/${session.sid}/account`, { account: account.id });
  const url = new URL("/ws", base);
  url.protocol = "ws:";
  url.searchParams.set("sid", session.sid);
  url.searchParams.set("e2e-owner", owner);
  url.searchParams.set("connectionKey", randomUUID());
  const socket = new WebSocket(url);
  const client = { index, sid: session.sid, account: account.id, socket, tab: undefined };
  socket.on("message", (bytes, binary) => {
    if (binary) return;
    const message = JSON.parse(bytes.toString());
    if (message.t === "snapshot")
      socket.send(JSON.stringify({ t: "view-ack", tab: message.tab, epoch: message.epoch }));
    if (message.t === "tabs") {
      const tab = message.tabs.find((t) => t.active);
      if (tab && tab.id !== client.tab) {
        client.tab = tab.id;
        socket.send(JSON.stringify({ t: "view", tab: tab.id, w: 1440, h: 900, dpr: 2 }));
      }
    }
  });
  await new Promise(
    (resolve, reject) => (socket.once("open", resolve), socket.once("error", reject)),
  );
  for (let i = 0; i < 80 && !client.tab; i++) await delay(250);
  if (!client.tab) throw Error(`account ${index} opened no tab`);
  return client;
}

const go = (client, url) =>
  client.socket.send(JSON.stringify({ t: "nav", tab: client.tab, action: "go", url }));
const text = async (client) =>
  (await api("/__e2e/evaluate", { sid: client.sid, expression: "document.body.innerText" })).value;
const after = (body, label) =>
  body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[
    body
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .indexOf(label) + 1
  ];

async function visit(clients, url, ready, ms = 60000) {
  for (const client of clients) go(client, url);
  const started = Date.now();
  const bodies = new Map();
  while (Date.now() - started < ms && bodies.size < clients.length) {
    await delay(3000);
    for (const client of clients) {
      if (bodies.has(client)) continue;
      const body = await text(client).catch(() => "");
      if (ready(body)) bodies.set(client, body);
    }
  }
  return bodies;
}

const clients = [];
for (let i = 1; i <= Number(count); i++) clients.push(await openAccount(i));
const rows = clients.map((client) => ({ account: client.account }));

const who = await visit(
  clients,
  "https://who.1ms.dog/",
  (b) => /signals read/.test(b) && /Grade/.test(b),
);
clients.forEach((client, i) => {
  const body = who.get(client) ?? "";
  rows[i].whoId = after(body, "BROWSER FINGERPRINT ID") ?? "(not loaded)";
  rows[i].hardware = /Hardware ID \(across browsers\)\n([^ \n]+)/.exec(body)?.[1];
  rows[i].grade = /Grade ([A-F][+-]?)/.exec(body)?.[1];
  rows[i].tampered = after(body, "Tampered environment");
  rows[i].tells = after(body, "Anti-detect tells");
});

const fp = await visit(clients, "https://demo.fingerprint.com/playground", (b) =>
  /Suspect Score/.test(b),
);
clients.forEach((client, i) => {
  const body = fp.get(client) ?? "";
  rows[i].fpBot = after(body, "Bot") ?? "(not loaded)";
  rows[i].fpVm = after(body, "Virtual Machine");
});

console.table(rows);
const ids = new Set(rows.map((row) => row.whoId));
const problems = [];
if (ids.size !== rows.length) problems.push("accounts share a who.1ms.dog fingerprint id");
for (const row of rows) {
  if (row.grade !== "A+" && row.grade !== "A") problems.push(`${row.account}: grade ${row.grade}`);
  if (row.fpBot !== "Not detected")
    problems.push(`${row.account}: fingerprint.com bot ${row.fpBot}`);
}
for (const client of clients) client.socket.close();
if (problems.length) {
  console.log("Problems:\n- " + problems.join("\n- "));
  process.exitCode = 1;
} else console.log("Accounts differ and nothing reads them as a bot.");
