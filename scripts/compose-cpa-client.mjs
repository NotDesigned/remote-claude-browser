// Runs inside the server container as the gateway's user and drives cpa-broker over its socket,
// as the gateway does. compose-smoke.sh checks the containers and networks it leaves behind.
//   node compose-cpa-client.mjs ensure <id>   creates or starts an instance and calls it
//   node compose-cpa-client.mjs delete <id>   removes it with its volumes and network
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";

const socketPath = process.env.CPA_BROKER_SOCKET ?? "/run/cpa/cpa.sock";
const [action, id] = process.argv.slice(2);
if (!/^cpa-[a-f0-9]{20}$/.test(id ?? "")) throw new Error("usage: ensure|delete <cpa-id>");

function call(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers }, async (response) => {
      let text = "";
      for await (const chunk of response) text += chunk;
      resolve({ status: response.statusCode, text });
    });
    req.once("error", reject);
    req.end(body);
  });
}

if (action === "ensure") {
  // An instance keeps the keys it was first created with, as the gateway's store does.
  const keyFile = `/tmp/${id}.json`;
  const keys = existsSync(keyFile)
    ? JSON.parse(readFileSync(keyFile, "utf8"))
    : {
        apiKey: randomBytes(32).toString("base64url"),
        managementKey: randomBytes(32).toString("base64url"),
      };
  writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 });
  const { managementKey } = keys;
  const ensured = await call(
    "POST",
    `/instances/${id}/ensure`,
    JSON.stringify({ ...keys, proxyUrl: "http://compose-smoke:x@runtime-egress:8781" }),
    { "content-type": "application/json" },
  );
  if (ensured.status !== 200) throw new Error(`ensure ${id}: ${ensured.status} ${ensured.text}`);
  const listed = await call(
    "GET",
    `/instances/${id}/request?path=${encodeURIComponent("/v8/management/credentials")}`,
    undefined,
    { authorization: `Bearer ${managementKey}` },
  );
  if (listed.status !== 200 || !Array.isArray(JSON.parse(listed.text).files))
    throw new Error(`management ${id}: ${listed.status} ${listed.text}`);
  console.log(`CPA instance ${id} answers through the broker.`);
} else if (action === "delete") {
  const removed = await call("DELETE", `/instances/${id}`);
  if (removed.status !== 200) throw new Error(`delete ${id}: ${removed.status} ${removed.text}`);
} else throw new Error("usage: ensure|delete <cpa-id>");
