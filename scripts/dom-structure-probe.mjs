// Read-only structural diagnostics; never records conversation text or field values.
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createProbeSession } from "./probe-session.mjs";
// Pixel frames arrive as binary WebSocket frames (see encodePxBinary); keep only their metadata.
const pixelMessage = (raw) => {
  const b = new Uint8Array(raw);
  const n = (b[2] << 8) | b[3];
  return {
    t: "px",
    tab: new TextDecoder().decode(b.subarray(4, 4 + n)),
    w: (b[4 + n] << 8) | b[5 + n],
    h: (b[6 + n] << 8) | b[7 + n],
    data: "",
  };
};
if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");
const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
const WebSocket = require("ws");
const origin = process.env.MIRROR_ORIGIN ?? "http://127.0.0.1:3010";
const probe = await createProbeSession(origin);
try {
  await mkdir("artifacts", { recursive: true });
  const socket = probe.attach(new WebSocket(probe.socketUrl, { headers: probe.headers }));
  const documents = new Map();
  const allowed = new Set([
    "id",
    "class",
    "style",
    "viewBox",
    "viewbox",
    "width",
    "height",
    "fill",
    "stroke",
    "mask",
    "filter",
    "clip-path",
    "href",
    "xlink:href",
    "src",
    "rel",
    "type",
    "data-state",
    "data-testid",
    "aria-hidden",
    "aria-expanded",
    "data-icon",
    "_cssText",
  ]);
  function recordNode(nodes, node, parent) {
    if (!node || typeof node !== "object") return;
    const attributes = Object.fromEntries(
      Object.entries(node.attributes || {}).filter(([key]) => allowed.has(key)),
    );
    nodes.set(node.id, {
      id: node.id,
      type: node.type,
      tag: node.tagName || null,
      parent,
      isSVG: !!node.isSVG,
      attributes,
      pathLength: String(node.attributes?.d || "").length,
    });
    for (const child of node.childNodes || []) recordNode(nodes, child, node.id);
  }
  function remove(nodes, id) {
    for (const child of nodes.values()) if (child.parent === id) remove(nodes, child.id);
    nodes.delete(id);
  }
  let role;
  let deltaEvents = 0;
  const timer = setTimeout(() => socket.close(), 7000);
  socket.on("message", (raw, isBinary) => {
    const message = isBinary ? pixelMessage(raw) : JSON.parse(String(raw));
    if (message.t === "hello") role = message.role;
    if (message.t !== "snapshot" && message.t !== "delta") return;
    if (message.t === "snapshot") documents.set(message.tab, new Map());
    const nodes = documents.get(message.tab);
    if (!nodes) return;
    for (const event of message.data) {
      if (event.type === 2) recordNode(nodes, event.data.node, null);
      if (event.type === 3 && event.data.source === 0) {
        deltaEvents++;
        for (const item of event.data.removes || []) remove(nodes, item.id);
        for (const item of event.data.adds || []) recordNode(nodes, item.node, item.parentId);
        for (const item of event.data.attributes || []) {
          const node = nodes.get(item.id);
          if (!node) continue;
          for (const [key, value] of Object.entries(item.attributes)) {
            if (!allowed.has(key)) continue;
            if (value === null) delete node.attributes[key];
            else node.attributes[key] = value;
          }
        }
      }
    }
  });
  await new Promise((resolve, reject) => {
    socket.on("close", resolve);
    socket.on("error", reject);
  });
  clearTimeout(timer);
  const nodes = [...documents.values()].flatMap((map) => [...map.values()]);
  const summary = {
    role,
    deltaEvents,
    totalNodes: nodes.length,
    counts: Object.fromEntries(
      ["svg", "path", "use", "symbol", "button", "nav", "aside", "link", "style"].map((tag) => [
        tag,
        nodes.filter((node) => node.tag === tag).length,
      ]),
    ),
    conversationLinks: nodes.filter(
      (node) => node.tag === "a" && /\/chat\//.test(String(node.attributes.href || "")),
    ).length,
  };
  // Attributes are local diagnostic material; keep this file private and never print text labels.
  await writeFile(
    "artifacts/dom-current-structure.json",
    JSON.stringify({ summary, nodes }, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify(
      {
        svgReferences: nodes
          .filter((node) => ["use", "image", "svg"].includes(node.tag))
          .map((node) => ({
            id: node.id,
            tag: node.tag,
            isSVG: node.isSVG,
            width: node.attributes.width,
            height: node.attributes.height,
            viewBox: node.attributes.viewBox,
            hrefKind: node.attributes.href?.startsWith("#")
              ? "local-fragment"
              : node.attributes.href
                ? "external"
                : "none",
            children: nodes.filter((child) => child.parent === node.id).length,
          }))
          .slice(0, 45),
        styleLinks: nodes
          .filter((node) => node.tag === "link" && node.attributes.rel === "stylesheet")
          .map((node) => ({
            id: node.id,
            inlined: !!node.attributes._cssText,
            proxied: String(node.attributes.href || "").startsWith("/s/"),
          })),
      },
      null,
      2,
    ),
  );
} finally {
  await probe.close();
}
