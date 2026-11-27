// The P1 gate for single-writer input (docs/records/2026-11-27-page-mode-p1-gate.md), run by
// composer-input-smoke.mts with COMPOSER_SMOKE_ONLY=gate on one device (SMOKE_DEVICE) and link.
//
// Five messages of mixed ASCII and Chinese go out in a row through the real ProseMirror composer,
// typing straight on after each send, while the viewer page is probed every frame: how soon what
// was typed is drawn (echo), whether the proxy keeps focus, whether a message's text is still
// shown after its send was acknowledged, whether the overlay shows an edit already acknowledged.
// Then autocorrect, an IME re-composing the previous word, an emoji deleted, a Backspace in the
// middle of a word, and a password. The page logs every keyboard and input event it gets, with
// isTrusted. The result is measured, not asserted: p1-gate.sh judges it against the criteria.
import type { CDPSession, FrameLocator, Page } from "playwright";
import { percentile } from "./ack-harness.mts";

export interface GateMirror {
  label: string;
  device: string;
  softKeyboard: boolean;
  proxy: boolean;
  page: Page;
  remote: Page;
  mirrored: FrameLocator;
  cdp: CDPSession;
  type(text: string, delay?: number): Promise<void>;
  compose(pinyin: string, text: string): Promise<void>;
  counters: { editableResyncs: number; bytesUp: number; bytesDown: number };
  failures: string[];
}

/** The fixture page's own event log (composer-input-smoke.mts installs it). */
interface LoggedEvent {
  type: string;
  isTrusted: boolean;
  inputType?: string;
  data?: string | null;
  key?: string;
  keyCode?: number;
  target: string;
}

type Part = string | [string, string];

/** Five messages, 40–120 characters each, ASCII and Chinese. */
export const GATE_MESSAGES: Array<{ parts: Part[]; expected: string }> = [
  {
    parts: [
      "Hello from the proxy, the first message says ",
      ["nihao", "你好"],
      " and goes on a bit",
    ],
    expected: "Hello from the proxy, the first message says 你好 and goes on a bit",
  },
  {
    parts: ["second one -- with a dash, then ", ["zhongwen", "中文"], " in the middle of it"],
    expected: "second one — with a dash, then 中文 in the middle of it",
  },
  {
    parts: ["third: numbers 12345 and marks ?!., then ", ["shijie", "世界"], " to end three"],
    expected: "third: numbers 12345 and marks ?!., then 世界 to end three",
  },
  {
    parts: ["fourth message typed straight on after sending, plain ascii only, longer than others"],
    expected:
      "fourth message typed straight on after sending, plain ascii only, longer than others",
  },
  {
    parts: ["fifth ", ["xiexie", "谢谢"], " and the final words of the very last message here"],
    expected: "fifth 谢谢 and the final words of the very last message here",
  },
];

/** Probes in the viewer page: one rAF loop sampling what the person would see. */
const installProbe = (legacy: boolean) => {
  const w = window as any;
  const probe = {
    frames: 0,
    watchFocus: false,
    activeMisses: 0,
    missSamples: [] as string[],
    double: 0,
    stale: 0,
    staleSamples: [] as string[],
    needles: [] as Array<{ iseq: number; text: string; active: boolean }>,
    vvMin: Infinity,
    vvMax: 0,
    passwordLeak: 0,
    leakSamples: [] as string[],
    watchPassword: false,
    legacyEcho: [] as number[],
    stop: false,
  };
  w.__gateProbe = probe;
  const composer = () => {
    const frame = document.querySelector("#mirror-host iframe") as HTMLIFrameElement | null;
    return frame?.contentDocument?.getElementById("composer") ?? null;
  };
  if (legacy) {
    // The replay's own field is what echoes typing without single-writer input.
    const attach = () => {
      const frame = document.querySelector("#mirror-host iframe") as HTMLIFrameElement | null;
      const doc = frame?.contentDocument;
      if (!doc || (doc as any).__gateEcho) return;
      (doc as any).__gateEcho = true;
      doc.addEventListener(
        "input",
        (event) => {
          if (!event.isTrusted) return;
          const stamp = event.timeStamp;
          requestAnimationFrame((time) => probe.legacyEcho.push(time - stamp));
        },
        true,
      );
    };
    attach();
    setInterval(attach, 200);
  }
  const loop = () => {
    if (probe.stop) return;
    probe.frames += 1;
    const lab = w.__mirrorInputLab;
    const proxy = lab?.proxy;
    const state = proxy?.state();
    if (probe.watchFocus && proxy && document.activeElement !== proxy.element()) {
      probe.activeMisses += 1;
      if (probe.missSamples.length < 5)
        probe.missSamples.push(
          `${document.activeElement?.tagName ?? "none"}@${Math.round(performance.now())}`,
        );
    }
    if (state && state.shown.some((iseq: number) => iseq <= state.settledPage)) probe.double += 1;
    const settled: Array<{ tab: string; iseq: number; mode: string }> = lab?.settled ?? [];
    const lastPage = settled.filter((ack) => ack.mode === "page").at(-1)?.iseq ?? 0;
    const shownText = (composer()?.textContent ?? "") + (state?.text ?? "");
    for (const needle of probe.needles) {
      if (!needle.active && lastPage >= needle.iseq) needle.active = true;
      if (needle.active && shownText.includes(needle.text)) {
        probe.stale += 1;
        if (probe.staleSamples.length < 5) probe.staleSamples.push(shownText.slice(-60));
      }
    }
    if (probe.watchPassword && state && /[^•]/.test(state.text)) {
      probe.passwordLeak += 1;
      if (probe.leakSamples.length < 5) probe.leakSamples.push(JSON.stringify(state));
    }
    const height = window.visualViewport?.height ?? window.innerHeight;
    probe.vvMin = Math.min(probe.vvMin, height);
    probe.vvMax = Math.max(probe.vvMax, height);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
};

const readProbe = () => {
  const w = window as any;
  const probe = w.__gateProbe;
  const lab = w.__mirrorInputLab;
  const proxy = lab?.proxy;
  return {
    probe: { ...probe, needles: probe.needles.length },
    lab: proxy
      ? { ...proxy.lab, echo: [...proxy.lab.echo], echoSync: [...proxy.lab.echoSync] }
      : null,
    state: proxy?.state() ?? null,
    model: proxy?.model() ?? null,
    stats: lab.stats(),
    settled: lab.settled.map((ack: any) => ({
      iseq: ack.iseq,
      mode: ack.mode,
      failed: ack.failed,
      final: ack.final,
      edit: ack.edit ?? null,
      rtt: ack.rtt,
    })),
    stamped: lab.lastStamped("composer"),
    active: document.activeElement?.getAttribute("data-proxy-input") === "true",
  };
};

const soft = { key: "Unidentified", keyCode: 229, windowsVirtualKeyCode: 229 };

export async function proxyGate(m: GateMirror): Promise<Record<string, unknown>> {
  const { page, remote, mirrored, cdp, type, compose } = m;
  const composerText = () =>
    remote.evaluate(() => (window as any).composerView.state.doc.textContent as string);
  const sent = () => remote.evaluate(() => [...(window as any).sentMessages] as string[]);
  const focusField = async (selector: string) => {
    if (m.softKeyboard) await mirrored.locator(selector).tap();
    else await mirrored.locator(selector).click();
    await page.waitForTimeout(500);
  };
  const enter = async () => {
    if (m.softKeyboard) {
      // A soft keyboard's Return: its placeholder key and an insertParagraph, no Enter key event.
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...soft });
      await cdp.send("Input.dispatchKeyEvent", { type: "char", text: "\r" });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...soft });
    } else await page.keyboard.press("Enter");
  };
  const typeParts = async (parts: Part[], delay = 30) => {
    for (const part of parts)
      await (typeof part === "string" ? type(part, delay) : compose(part[0], part[1]));
  };
  /** Selects `word` (its last occurrence) where the person types: the proxy, or the replay. */
  const selectWord = async (word: string) => {
    if (m.proxy)
      return page.evaluate((word) => {
        const field = document.querySelector("[data-proxy-input]") as HTMLTextAreaElement;
        const at = field.value.lastIndexOf(word);
        if (at < 0) return false;
        field.setSelectionRange(at, at + word.length);
        return true;
      }, word);
    return mirrored.locator("#composer").evaluate((editor, word) => {
      const document = editor.ownerDocument;
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = node.textContent!.lastIndexOf(word);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + word.length);
        document.getSelection()!.removeAllRanges();
        document.getSelection()!.addRange(range);
        return true;
      }
      return false;
    }, word);
  };

  // tsx names inner functions with a helper the page does not have.
  await page.evaluate("window.__name = window.__name || ((fn) => fn)");
  const caretToEnd = async () => {
    if (m.proxy)
      await page.evaluate(() => {
        const field = document.querySelector("[data-proxy-input]") as HTMLTextAreaElement;
        field.setSelectionRange(field.value.length, field.value.length);
      });
    else
      await mirrored.locator("#composer").evaluate((editor) => {
        const selection = editor.ownerDocument.getSelection()!;
        selection.selectAllChildren(editor);
        selection.collapseToEnd();
      });
  };
  await page.evaluate(installProbe, !m.proxy);
  await remote.evaluate(() => {
    (window as any).inputLog.length = 0;
    (window as any).untrustedEvents = 0;
  });
  await focusField("#composer");
  const focusedProxy = await page.evaluate(
    () => document.activeElement?.getAttribute("data-proxy-input") === "true",
  );
  const sentBefore = (await sent()).length;
  const cpuBefore = process.cpuUsage();
  const bytesBefore = { ...m.counters };
  const started = performance.now();
  let keyLaneChars = 0;
  // G2/G4/G6/G7: five sends in a row.
  for (const [index, message] of GATE_MESSAGES.entries()) {
    await page.evaluate(() => ((window as any).__gateProbe.watchFocus = true));
    await typeParts(message.parts);
    if (!m.softKeyboard)
      for (const part of message.parts) if (typeof part === "string") keyLaneChars += part.length;
    await page.waitForTimeout(index % 2 ? 60 : 400);
    await enter();
    const iseq = await page.evaluate(() =>
      (window as any).__mirrorInputLab.lastStamped("composer"),
    );
    await page.evaluate(
      ({ iseq, text }) => (window as any).__gateProbe.needles.push({ iseq, text, active: false }),
      { iseq, text: message.expected.slice(-14) },
    );
    await page.waitForTimeout(index % 2 ? 30 : 200);
  }
  await page.evaluate(() => ((window as any).__gateProbe.watchFocus = false));
  await page.waitForTimeout(3_000);
  const typingMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const bytes = {
    up: m.counters.bytesUp - bytesBefore.bytesUp,
    down: m.counters.bytesDown - bytesBefore.bytesDown,
  };
  const sends = (await sent()).slice(sentBefore);
  const afterSends = {
    page: await composerText(),
    replay: (await mirrored.locator("#composer").textContent()) ?? "",
    pending: (await page.evaluate(readProbe)).state?.pending ?? 0,
  };
  const log = (await remote.evaluate(() => [...(window as any).inputLog])) as LoggedEvent[];
  const untrusted = await remote.evaluate(() => (window as any).untrustedEvents as number);
  const charCount = GATE_MESSAGES.reduce((sum, message) => sum + message.expected.length, 0);

  // G6: every key-lane character came as a trusted keydown, beforeinput and input, once each.
  const composerLog = log.filter((event) => event.target === "composer");
  const keydowns = composerLog.filter(
    (event) =>
      event.type === "keydown" &&
      event.isTrusted &&
      [...(event.key ?? "")].length === 1 &&
      event.keyCode !== 229,
  ).length;
  let unkeyedBeforeInput = 0;
  let lastKeydown: LoggedEvent | null = null;
  for (const event of composerLog) {
    if (event.type === "keydown") lastKeydown = event;
    if (event.type === "beforeinput" && event.inputType === "insertText") {
      const data = event.data ?? "";
      if (!m.softKeyboard && /^[\x20-\x7e]$/.test(data) && lastKeydown?.key !== data)
        unkeyedBeforeInput += 1;
      lastKeydown = null;
    }
  }
  const untrustedText = composerLog.filter(
    (event) => (event.type === "beforeinput" || event.type === "input") && !event.isTrusted,
  ).length;
  const textBeforeInputs = composerLog.filter(
    (event) => event.type === "beforeinput" && event.inputType === "insertText" && event.isTrusted,
  ).length;

  // G5: composition, autocorrect, re-composition, emoji, Backspace mid-word.
  const g5: Array<{ name: string; sent: string[]; expected: string; ok: boolean }> = [];
  const g5case = async (name: string, expected: string, body: () => Promise<void>) => {
    const before = (await sent()).length;
    await body();
    await page.waitForTimeout(500);
    await enter();
    await page.waitForTimeout(1_500);
    const got = (await sent()).slice(before);
    g5.push({ name, sent: got, expected, ok: got.length === 1 && got[0] === expected });
  };
  const proxyActive = () =>
    page.evaluate(() => document.activeElement?.getAttribute("data-proxy-input") === "true");
  const refocus = async () => {
    if (m.proxy ? !(await proxyActive()) : false) await focusField("#composer");
  };
  await refocus();
  await g5case("autocorrect teh → the", "fix the word", async () => {
    await type("fix teh ");
    await page.waitForTimeout(300);
    // The keyboard replaces the word and its space at once, the caret staying after them.
    if (await selectWord("teh ")) await cdp.send("Input.insertText", { text: "the " });
    await page.waitForTimeout(200);
    await type("word");
  });
  await refocus();
  await g5case("IME re-composes the previous word", "hello world", async () => {
    await type("hello wrold");
    await page.waitForTimeout(300);
    if (await selectWord("wrold")) {
      for (const preedit of ["w", "wo", "wor", "worl", "world"])
        await cdp.send("Input.imeSetComposition", {
          text: preedit,
          selectionStart: preedit.length,
          selectionEnd: preedit.length,
        });
      await cdp.send("Input.insertText", { text: "world" });
    }
  });
  await refocus();
  await g5case("emoji deleted whole", "smile ok", async () => {
    await type("smile ");
    await cdp.send("Input.insertText", { text: "😀" });
    await page.waitForTimeout(300);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);
    await type("ok");
  });
  await refocus();
  await g5case("Backspace in the middle of a word", "abdef", async () => {
    await type("abcdef");
    await page.waitForTimeout(200);
    for (let index = 0; index < 3; index++) await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Backspace");
  });
  await refocus();
  await g5case("pinyin alone", "你好", async () => {
    await compose("nihao", "你好");
  });

  // G8: a password shows only dots and arrives as typed.
  await remote.evaluate(() => ((document.getElementById("secret") as HTMLInputElement).value = ""));
  await focusField("#secret");
  await page.evaluate(() => ((window as any).__gateProbe.watchPassword = true));
  const password = "s3cret pw";
  await type(password);
  await page.waitForTimeout(1_500);
  await page.evaluate(() => ((window as any).__gateProbe.watchPassword = false));
  const passwordValue = await remote.evaluate(
    () => (document.getElementById("secret") as HTMLInputElement).value,
  );
  await page.evaluate(() => ((window as any).__gateProbe.stop = true));
  const report = await page.evaluate(readProbe);
  // The password field is the one the last acks report; none of its reports carries a hash.
  const passwordId = report.settled.at(-1)?.edit?.node;
  const passwordEdits = report.settled
    .map((ack: any) => ack.edit)
    .filter((edit: any) => edit && edit.node === passwordId);
  const passwordNode = passwordEdits.filter((edit: any) => edit.hash === "").length;
  const passwordHashes = passwordEdits.filter((edit: any) => edit.hash !== "").length;

  const echo = m.proxy ? (report.lab?.echo ?? []) : report.probe.legacyEcho;
  const echoSync = report.lab?.echoSync ?? [];
  const failedAcks = report.settled.filter((ack: any) => (ack.failed ?? []).length > 0).length;
  const rtts = report.settled.flatMap((ack: any) => (ack.rtt === undefined ? [] : [ack.rtt]));
  const result = {
    label: m.label,
    device: m.device,
    input: m.proxy ? "proxy" : "legacy",
    focusedProxy,
    g1: {
      samples: echo.length,
      p50: percentile(echo, 0.5),
      p95: percentile(echo, 0.95),
      max: echo.length === 0 ? null : Math.max(...echo),
      syncP95: percentile(echoSync, 0.95),
    },
    g2: {
      sent: sends,
      expected: GATE_MESSAGES.map((message) => message.expected),
      pageComposer: afterSends.page,
      replayComposer: afterSends.replay,
      pending: afterSends.pending,
      staleFrames: report.probe.stale,
      staleSamples: report.probe.staleSamples,
    },
    g3: {
      unsynced: m.failures.length,
      failedAcks,
      editableResyncs: m.counters.editableResyncs,
    },
    g4: {
      activeMisses: report.probe.activeMisses,
      missSamples: report.probe.missSamples,
      blurs: report.lab?.blurs ?? null,
      vvMin: report.probe.vvMin,
      vvMax: report.probe.vvMax,
    },
    g5: { cases: g5, planFallback: report.lab?.planFallback ?? null },
    g6: {
      keyLaneChars,
      keydowns,
      textBeforeInputs,
      unkeyedBeforeInput,
      untrustedText,
      untrustedEvents: untrusted,
    },
    g7: {
      doubleFrames: report.probe.double,
      gapFrames: report.lab?.gapFrames ?? null,
      mismatchFrames: report.lab?.mismatchFrames ?? null,
      gapRuns: report.lab?.gapRuns.length ?? null,
      gapRunP95: report.lab ? percentile(report.lab.gapRuns, 0.95) : null,
      gapRunMax:
        report.lab && report.lab.gapRuns.length > 0 ? Math.max(...report.lab.gapRuns) : null,
      frames: report.probe.frames,
    },
    g8: {
      leakFrames: report.probe.passwordLeak,
      leakSamples: report.probe.leakSamples,
      value: passwordValue === password,
      passwordAcksWithoutHash: passwordNode,
      passwordHashes,
    },
    recorded: {
      ackRttP50: percentile(rtts, 0.5),
      ackRttP95: percentile(rtts, 0.95),
      hashMismatch: report.lab?.hashMismatch ?? null,
      late: report.lab?.late ?? null,
      reseeds: report.lab?.reseeds ?? null,
      bytesUpPerChar: Number((bytes.up / charCount).toFixed(1)),
      bytesDownPerChar: Number((bytes.down / charCount).toFixed(1)),
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      typingMs: Math.round(typingMs),
      stamped: report.stamped,
    },
  };
  return result;
}
