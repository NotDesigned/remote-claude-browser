// Runs inside the server container as the gateway's user and drives cpa-broker over its socket,
// as the gateway does. compose-smoke.sh pipes it to node and checks what it leaves behind.
//   ensure <id> <api key> <management key>   creates or starts an instance and calls it
//   delete <id>                              removes it with its volumes and network
import { request } from "node:http";

const socketPath = process.env.CPA_BROKER_SOCKET ?? "/run/cpa/cpa.sock";
const [action, id, apiKey, managementKey] = process.argv.slice(2);
const usage = "usage: ensure <cpa-id> <api key> <management key> | delete <cpa-id>";
if (!/^cpa-[a-f0-9]{20}$/.test(id ?? "")) throw new Error(usage);

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
  if (!apiKey || !managementKey) throw new Error(usage);
  const ensured = await call(
    "POST",
    `/instances/${id}/ensure`,
    JSON.stringify({
      apiKey,
      managementKey,
      proxyUrl: "http://compose-smoke:x@runtime-egress:8781",
    }),
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
} else throw new Error(usage);
