// Judges the P1 gate cells p1-gate.sh measured (one JSON per cell) against criteria G1–G8 and
// writes report.md and report.json next to them. Exits 1 when a single-writer cell misses a
// criterion or any cell's run failed.
//
//   node scripts/p1-gate-report.mjs tmp/p1-gate
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "tmp/p1-gate";
const names = readdirSync(dir)
  .filter((file) => file.endsWith(".exit"))
  .map((file) => file.slice(0, -".exit".length))
  .sort((a, b) => order(a) - order(b) || a.localeCompare(b));

function order(name) {
  const [input, rtt, loss] = name.split("-");
  return (input === "legacy" ? 1e6 : 0) + Number(rtt) * 100 + Number(loss) * 1000;
}

const round = (value) =>
  value === null || value === undefined ? "–" : Math.round(value * 10) / 10;

/** Each criterion: [pass, what was measured]. */
function judge(cell) {
  const phone = cell.device !== "desktop";
  const g = {};
  g.G1 = [
    cell.g1.samples >= 200 && cell.g1.p95 !== null && cell.g1.p95 < 16.7 && cell.g1.max < 20,
    `p50 ${round(cell.g1.p50)} / p95 ${round(cell.g1.p95)} / max ${round(cell.g1.max)} ms (n=${cell.g1.samples})`,
  ];
  const sentOk = JSON.stringify(cell.g2.sent) === JSON.stringify(cell.g2.expected);
  g.G2 = [
    sentOk &&
      cell.g2.pageComposer === "" &&
      cell.g2.replayComposer === "" &&
      cell.g2.pending === 0 &&
      cell.g2.staleFrames === 0,
    `${sentOk ? "5/5 once" : `sent ${JSON.stringify(cell.g2.sent)}`}, left ${JSON.stringify(cell.g2.pageComposer)}/${JSON.stringify(cell.g2.replayComposer)}, pending ${cell.g2.pending}, stale ${cell.g2.staleFrames}`,
  ];
  g.G3 = [
    cell.g3.unsynced === 0 && cell.g3.failedAcks === 0 && cell.g3.editableResyncs === 0,
    `未同步 ${cell.g3.unsynced}, failed ${cell.g3.failedAcks}, resyncs ${cell.g3.editableResyncs}`,
  ];
  g.G4 = [
    cell.g4.activeMisses === 0 && (cell.g4.blurs ?? 0) === 0 && cell.g4.vvMin === cell.g4.vvMax,
    `misses ${cell.g4.activeMisses}, blurs ${cell.g4.blurs}, vv ${cell.g4.vvMin}–${cell.g4.vvMax}`,
  ];
  const cases = cell.g5.cases;
  g.G5 = [
    cases.every((c) => c.ok) && (cell.g5.planFallback ?? 0) === 0,
    `${cases.filter((c) => c.ok).length}/${cases.length}${cases
      .filter((c) => !c.ok)
      .map((c) => ` [${c.name}: ${JSON.stringify(c.sent)}]`)
      .join("")}, fallback ${cell.g5.planFallback}`,
  ];
  g.G6 = [
    cell.g6.untrustedText === 0 &&
      cell.g6.untrustedEvents === 0 &&
      cell.g6.unkeyedBeforeInput === 0 &&
      (phone || cell.g6.keydowns === cell.g6.keyLaneChars),
    `keydown ${cell.g6.keydowns}/${cell.g6.keyLaneChars}, insertText ${cell.g6.textBeforeInputs}, untrusted ${cell.g6.untrustedEvents}, unkeyed ${cell.g6.unkeyedBeforeInput}`,
  ];
  g.G7 = [
    cell.g7.doubleFrames === 0 && (cell.g7.gapRunP95 ?? 0) <= 1,
    `double ${cell.g7.doubleFrames}, gap ${cell.g7.gapFrames} frames in ${cell.g7.gapRuns} runs (p95 ${round(cell.g7.gapRunP95)}, max ${round(cell.g7.gapRunMax)}), input-rule mismatch ${cell.g7.mismatchFrames ?? "–"}`,
  ];
  g.G8 = [
    cell.g8.leakFrames === 0 && cell.g8.value && cell.g8.passwordHashes === 0,
    `leaks ${cell.g8.leakFrames}, value ${cell.g8.value ? "ok" : "wrong"}, hashes ${cell.g8.passwordHashes}`,
  ];
  // The P0 ack checks (coverage, no dispatch-only ack, ordering); the page-hash race is noted.
  g.acks = [
    cell.ackChecks === "ok" || /final hashes matched/.test(cell.ackChecks ?? ""),
    cell.ackChecks ?? "–",
  ];
  return g;
}

const rows = [];
let failed = false;
for (const name of names) {
  const exit = Number(readFileSync(join(dir, `${name}.exit`), "utf8").trim());
  const file = join(dir, `${name}.json`);
  const cell = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const proxy = name.startsWith("proxy");
  if (cell === null) {
    rows.push({ name, exit, cell: null, judged: null });
    failed = true;
    continue;
  }
  const judged = judge(cell);
  if (exit !== 0) failed = true;
  if (proxy && Object.entries(judged).some(([key, [pass]]) => key !== "acks" && !pass))
    failed = true;
  rows.push({ name, exit, cell, judged });
}

const lines = [
  `| cell | run | ${["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "P0 acks"].join(" | ")} | ack RTT p50/p95 | bytes/char up/down | mismatch |`,
  `|${" --- |".repeat(14)}`,
];
for (const { name, exit, cell, judged } of rows) {
  if (cell === null) {
    lines.push(`| ${name} | exit ${exit}, no result |${" |".repeat(12)}`);
    continue;
  }
  const mark = ([pass, text]) => `${pass ? "✓" : "✗"} ${text}`;
  lines.push(
    `| ${name} | ${exit === 0 ? "ok" : `exit ${exit}`} | ${Object.values(judged).map(mark).join(" | ")} | ${round(cell.recorded.ackRttP50)}/${round(cell.recorded.ackRttP95)} | ${cell.recorded.bytesUpPerChar}/${cell.recorded.bytesDownPerChar} | ${cell.recorded.hashMismatch ?? "–"} |`,
  );
}
const summary = {};
for (const criterion of ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"]) {
  const proxyRows = rows.filter((row) => row.name.startsWith("proxy") && row.judged);
  summary[criterion] = proxyRows.every((row) => row.judged[criterion][0]) ? "pass" : "fail";
}
const report = [
  `# P1 gate: ${failed ? "FAIL" : "PASS"}`,
  "",
  Object.entries(summary)
    .map(([criterion, result]) => `${criterion} ${result}`)
    .join(", "),
  "",
  ...lines,
  "",
].join("\n");
writeFileSync(join(dir, "report.md"), report);
writeFileSync(
  join(dir, "report.json"),
  JSON.stringify(
    { failed, summary, cells: rows.map(({ name, exit, cell }) => ({ name, exit, cell })) },
    null,
    1,
  ),
);
console.log(report);
process.exit(failed ? 1 : 0);
