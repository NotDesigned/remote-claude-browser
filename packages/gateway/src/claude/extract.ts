import { editableText } from "@mirror/protocol";

const MESSAGE_SELECTOR =
  '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-response';
/**
 * Claude virtualizes long transcripts: only rows near the viewport exist in the DOM, each with an
 * absolute `data-index`. A message's position in chat state is that row number when rows exist.
 */
const ROW_SELECTOR = '[data-testid="transcript-row"]';
const SCROLLER_SELECTOR = "[data-autoscroll-container]";
const ATTACHMENT_SELECTOR = '[data-cds-composer-attachments] [data-testid="file-thumbnail"]';
const ATTACHMENT_REMOVE_SELECTOR = "button[data-cds-attachment-remove]";
const FILE_CONTROLS = String.raw`(e) => [...e.querySelectorAll('a[href], [data-testid="file-card-block"] button[aria-label]')].filter(a => a.tagName === 'BUTTON' ? /^(download\b|下载)/i.test(a.getAttribute('aria-label') || '') : a.hasAttribute('download') || /^(blob:|sandbox:)|download|attachment|\/files\//i.test(a.getAttribute('href') || '')).slice(0, 20)`;
const FILE_NAME = String.raw`(e) => (e.getAttribute('download') || (e.getAttribute('aria-label') || '').replace(/^(download\b|下载)\s*/i, '') || e.textContent || '下载文件').trim().slice(0, 200)`;

/** Read message text without forcing layout or including accessibility duplicates and controls. */
const MESSAGE_TEXT = String.raw`(element, rich = true) => {
  const skip = 'button, script, style, svg, .sr-only, [aria-hidden="true"], [data-testid="message-actions"], [data-testid="user-message-actions"], [class~="group/status"], [data-file-row-card]';
  const read = node => {
    if (node.nodeType === 3) {
      // The source's own line break after a <br> is only whitespace.
      const text = (node.textContent || '').replace(node.previousSibling?.nodeName === 'BR' ? /^\s+/ : /^/, '');
      return rich ? text.replace(/([\\\x60*_\[\]~$#>])/g, '\\$1') : text;
    }
    if (node.nodeType !== 1) return '';
    if (node.matches('.katex-display, .katex, math, mjx-container')) {
      const tex = (node.querySelector('annotation[encoding="application/x-tex"]')?.textContent || node.getAttribute('data-latex') || node.getAttribute('data-tex') || node.getAttribute('alttext') || '').trim();
      if (tex) { const block = node.matches('.katex-display, [display="block"], [display="true"]'); return block ? '\n$$\n' + tex + '\n$$\n' : '$' + tex + '$'; }
    }
    const tick = String.fromCharCode(96);
    const fenced = (pre, label) => {
      const code = pre.querySelector('code');
      const body = code?.textContent || pre.textContent || '';
      const named = (code?.getAttribute('class') || '').match(/language-([\w+#.-]+)/)?.[1] || label;
      const language = /^[\w+#.-]{1,30}$/.test(named) ? named : '';
      const fence = tick.repeat(Math.max(3, ...(body.match(/\x60+/g) || []).map(run => run.length + 1)));
      return '\n' + fence + language + '\n' + body.replace(/\n$/, '') + '\n' + fence + '\n';
    };
    // Claude's code block wraps <pre> with a language label and a copy button.
    if (node.matches('[role="group"][aria-label="Code"]')) {
      const pre = node.querySelector('pre');
      if (pre) {
        const label = [...node.children].find(c => !c.contains(pre) && !c.querySelector('button'));
        return fenced(pre, (label?.textContent || '').trim());
      }
    }
    if (node.matches(skip)) return '';
    if (node.tagName === 'PRE') return fenced(node, '');
    if (node.tagName === 'CODE' && node.parentElement?.tagName !== 'PRE') return tick + (node.textContent || '') + tick;
    if (node.tagName === 'BR') return rich ? '  \n' : '\n';
    const text = [...node.childNodes].map(read).join('');
    // A process row shows its label and detail side by side, as two adjacent elements.
    if (/-meta$/.test(node.id || '') && node.previousElementSibling) return ' ' + text;
    if (rich) {
      if (/^H[1-6]$/.test(node.tagName)) return '\n' + '#'.repeat(Number(node.tagName[1])) + ' ' + text.trim() + '\n\n';
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') || '';
        // Downloads are offered as file buttons through the gateway; never as a direct link.
        const download = node.hasAttribute('download') || /^(blob:|sandbox:)|\/files\/|attachment/i.test(href);
        if (!download && /^(https?:|mailto:|\/)/i.test(href)) {
          const url = new URL(href, location.href).href.replace(/\(/g, '%28').replace(/\)/g, '%29');
          return '[' + text + '](' + url + ')';
        }
      }
      if (node.tagName === 'STRONG' || node.tagName === 'B') return '**' + text + '**';
      if (node.tagName === 'EM' || node.tagName === 'I') return '*' + text + '*';
      if (node.tagName === 'DEL' || node.tagName === 'S') return '~~' + text + '~~';
      if (node.tagName === 'LI') {
        const ordered = node.parentElement?.tagName === 'OL';
        const index = ordered ? Number(node.parentElement.getAttribute('start') || 1) + [...node.parentElement.children].indexOf(node) : 0;
        return (ordered ? index + '. ' : '- ') + text.trim().replace(/\n/g, '\n  ') + '\n';
      }
      if (node.tagName === 'UL' || node.tagName === 'OL') return '\n' + text + '\n';
      if (node.tagName === 'BLOCKQUOTE') return '\n' + text.trim().split('\n').map(line => '> ' + line).join('\n') + '\n\n';
      if (node.tagName === 'HR') return '\n---\n';
      if (node.tagName === 'TABLE') {
        const rows = [...node.querySelectorAll('tr')].map(row => [...row.querySelectorAll('th,td')].map(cell => read(cell).trim().replace(/\|/g, '\\|').replace(/\n/g, ' ')));
        if (!rows.length) return '';
        const width = Math.max(...rows.map(row => row.length));
        const line = row => '| ' + Array.from({length:width}, (_, index) => row[index] || '').join(' | ') + ' |';
        return '\n' + [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n') + '\n\n';
      }
    }
    if (rich && node.tagName === 'P') return text.trim() + '\n\n';
    if (node.tagName === 'TD' || node.tagName === 'TH') return text + '\t';
    return /^(P|DIV|LI|PRE|BLOCKQUOTE|H[1-6]|TR)$/.test(node.tagName) ? text + '\n' : text;
  };
  const body = element.querySelector('[data-testid="message-content"], .font-claude-response') || element;
  return read(body).replace(/\n{3,}/g, '\n\n').trim().slice(0, 1000000);
}`;

/** Isolated-world global holding the per-message serialization cache (see observe.ts). */
export const CHAT_CACHE_GLOBAL = "__mirrorChatCache";
export const CHAT_MESSAGE_SELECTOR = MESSAGE_SELECTOR;

/**
 * Thinking and other process rows (`group/status`) sit above the answer: a one-line summary,
 * an expand button, and their detail only while expanded. They are reported separately so the
 * summary never leaks into the answer text.
 */
const STATUS_STEPS = String.raw`(element) => [...element.querySelectorAll('[class~="group/status"]')]
  .filter(s => !s.parentElement?.closest('[class~="group/status"]'))
  .slice(0, 20)
  .map(s => {
    const header = s.firstElementChild;
    const live = s.querySelector(':scope > [role="status"]');
    const titled = s.querySelector('[data-morph-key]');
    const summary = ((titled && plainText(titled)) || (live && plainText(live)) || (header && plainText(header)) || '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
    // Open rows show their detail; many closed rows keep it in a hidden find-in-page layer.
    const hidden = s.querySelector('[data-cds-findable]');
    const text = ([...s.children].filter(c => c !== header && c !== live).map(c => messageText(c, false)).filter(Boolean).join('\n').trim() || (hidden && hidden.textContent) || '').trim().slice(0, 20000);
    return text ? { summary, text, state: s.getAttribute('data-state') || '' } : { summary, state: s.getAttribute('data-state') || '' };
  })
  .filter(step => step.summary || step.text)`;

/** Document and artifact cards (for example Claude Docs) are listed apart from the reply text. */
const MESSAGE_CARDS = String.raw`(element) => [...element.querySelectorAll('[data-file-row-card]')]
  .map(card => {
    const open = card.querySelector('[data-testid="frame-card-open"]');
    const clean = value => (value || '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
    const title = clean(open ? open.textContent : card.textContent).slice(0, 200);
    const subtitle = open ? clean(card.textContent).replace(title, '').trim().slice(0, 100) : '';
    return { title, subtitle, openable: !!open };
  })
  .filter(card => card.title)
  .slice(0, 20)`;

/** Runs only in authoritative Chromium on B. No website scripts or HTML reach this UI. */
export const CHAT_EXPRESSION = String.raw`(() => {
  const visible = e => !!e && e.isConnected && !e.closest('[hidden], [inert], [aria-hidden="true"]');
  const editor = [...document.querySelectorAll('.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"], textarea[placeholder]')].find(visible);
  // Sign-in and logout pages reuse the reply typography for marketing copy; never read them as chat.
  const signedOut = /^\/(login|logout|oauth|auth|magic-link)(\/|$)/i.test(location.pathname);
  const candidates = signedOut ? [] : [...document.querySelectorAll(${JSON.stringify(MESSAGE_SELECTOR)})];
  const tops = candidates.filter(e => !candidates.some(p => p !== e && p.contains(e)));
  const messageText = ${MESSAGE_TEXT};
  // Shimmering text holds a hidden second copy of itself for its animation.
  const plainText = element => {
    if (!element.querySelector('[data-cds-shimmer-clone]')) return element.textContent || '';
    const copy = element.cloneNode(true);
    copy.querySelectorAll('[data-cds-shimmer-clone]').forEach(clone => clone.remove());
    return copy.textContent || '';
  };
  // In the observer's isolated world a cache keeps each message's serialized content until a
  // mutation inside that message marks it dirty, so streaming re-reads only the changing reply.
  const cache = globalThis.${CHAT_CACHE_GLOBAL};
  const read = e => {
    const user = e.matches('[data-testid="user-message"]');
    let content = cache && !cache.dirty.has(e) ? cache.entries.get(e) : undefined;
    if (!content) {
      const steps = user ? [] : (${STATUS_STEPS})(e);
      const cards = user ? [] : (${MESSAGE_CARDS})(e);
      content = {
        text: messageText(e, !user),
        files: (${FILE_CONTROLS})(e).map((a, id) => ({ id: String(id), name: (${FILE_NAME})(a) })),
        ...(steps.length ? { steps } : {}),
        ...(cards.length ? { cards } : {})
      };
      if (cache) { cache.entries.set(e, content); cache.dirty.delete(e); }
    }
    return { role: user ? 'user' : 'assistant', ...content };
  };
  const rowElement = e => e.closest(${JSON.stringify(ROW_SELECTOR)});
  const rowNumbers = tops.map(e => { const value = rowElement(e)?.getAttribute('data-index'); return value && /^\d+$/.test(value) ? Number(value) : -1; });
  const rowed = rowNumbers.length > 0 && !rowNumbers.includes(-1) && new Set(rowNumbers).size === rowNumbers.length;
  // Moving between conversations can leave the old rows mounted for a moment under the new URL.
  if (cache) {
    if (cache.seenPath !== location.pathname) { cache.stale = cache.seenPath === undefined ? undefined : cache.seen; cache.seenPath = location.pathname; }
    cache.seen = new WeakSet(tops);
  }
  const stale = e => {
    if (!cache || !cache.stale || !cache.stale.has(e)) return false;
    if (!cache.dirty.has(e)) return true;
    cache.stale.delete(e);
    return false;
  };
  const rowedMessages = () => {
    const known = [];
    let total = 0;
    tops.forEach((e, index) => {
      if (stale(e)) return;
      const row = rowNumbers[index];
      const size = Number(rowElement(e).querySelector('[role="article"]')?.getAttribute('aria-setsize')) || 0;
      total = Math.max(total, size, row + 1);
      known[row] = { id: 'r' + row, ...read(e) };
    });
    // Rows that are not mounted stay as placeholders, so every index is the absolute row number.
    return Array.from({ length: Math.min(total, 5000) }, (_, row) => known[row] || { id: 'r' + row, role: 'assistant', text: '', pending: true });
  };
  const messages = rowed ? rowedMessages() : tops.slice(-300).map((e, index) => ({
    id: e.closest('[data-message-id]')?.getAttribute('data-message-id') || String(index),
    ...read(e)
  }));
  const attachments = [...document.querySelectorAll(${JSON.stringify(ATTACHMENT_SELECTOR)})].slice(0, 20).map(tile => {
    const remove = tile.querySelector(${JSON.stringify(ATTACHMENT_REMOVE_SELECTOR)});
    const name = ((remove?.getAttribute('aria-label') || '').replace(/^(remove|删除|移除)\s*/i, '') || tile.textContent || '附件').trim().slice(0, 200);
    return { name, removable: !!remove };
  });
  const conversations = [...document.querySelectorAll('a[href^="/chat/"]')].map(e => ({path: new URL(e.href).pathname, title: plainText(e).trim().slice(0, 150)})).filter(e => e.title && /^\/chat\/[a-zA-Z0-9-]+$/.test(e.path));
  const first = selector => document.querySelectorAll(selector)[0];
  const words = element => [...(element?.querySelectorAll('span') || [])].filter(span => !span.children.length).map(span => (span.textContent || '').trim()).filter(Boolean);
  const modelButton = first('[data-testid="model-selector-dropdown"]');
  const allButtons = modelButton ? [...document.querySelectorAll('button')] : [];
  const sidebarToggle = first('button[aria-keyshortcuts="Control+b"]');
  const surface = {
    model: words(modelButton)[0] || '',
    effort: words(modelButton)[1] || '',
    // Claude keeps its other modes laid over the current one, hidden.
    mode: modelButton ? (allButtons.slice(allButtons.indexOf(modelButton) + 1, allButtons.indexOf(modelButton) + 4).filter(b => b.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) !== false).map(b => (b.textContent || '').replace(/[-]/g, '').trim()).find(Boolean) || '').slice(0, 40) : '',
    project: (first('[data-picker-label]')?.textContent || '').trim().slice(0, 80),
    placeholder: (first('[data-testid="chat-input"]')?.getAttribute('aria-placeholder') || '').slice(0, 200),
    greeting: (first('[data-new-page-greeting-text]')?.textContent || '').trim().slice(0, 300),
    sidebarClosed: !!sidebarToggle && /show|显示|展开/i.test(sidebarToggle.getAttribute('aria-label') || '')
  };
  const stop = [...document.querySelectorAll('button[aria-label], button[data-testid]')].find(e => /stop|停止/i.test((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('data-testid') || '')) && visible(e));
  const editorText = ${editableText.toString()};
  const draft = editor ? ('value' in editor ? editor.value : editorText(editor)) : '';
  return {url: location.href, title: document.title, signedOut, ready: !signedOut && !!editor, draft: draft.trim() ? draft.slice(0, 100000) : '', generating: !!stop, messages, attachments, surface, conversations: [...new Map(conversations.map(e => [e.path,e])).values()].slice(0,100)};
})()`;

export const EDITOR_FOCUS_EXPRESSION = `(() => {
  const e = [...document.querySelectorAll('.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"], textarea[placeholder]')].find(e => e.isConnected && !e.closest('[hidden], [inert], [aria-hidden="true"]'));
  if (!e) return false;
  e.focus({preventScroll:true});
  if ('value' in e) e.setSelectionRange(0, e.value.length);
  else { const range = document.createRange(); range.selectNodeContents(e); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
  return document.activeElement === e;
})()`;

export function buttonExpression(kind: "send" | "stop", click = false): string {
  const matcher = kind === "send" ? "/^(send message|send|发送消息|发送)$/i" : "/stop|停止/i";
  return `(() => {
    const e = [...document.querySelectorAll('button')].find(e => !e.disabled && ${matcher}.test((e.getAttribute('aria-label') || e.getAttribute('data-testid') || e.textContent || '').trim()) && ${click ? "e.isConnected && !e.closest('[hidden], [inert], [aria-hidden=\"true\"]')" : "e.getClientRects().length"});
    if (!e) return ${click ? "false" : "null"};
    ${click ? "e.click(); return true;" : ""}
    e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`;
}

/** Finds one message by chat-state index: its row when virtualized, else its mounted position. */
const findMessage = (index: number) => `(() => {
  const within = scope => {
    const candidates = [...scope.querySelectorAll(${JSON.stringify(MESSAGE_SELECTOR)})];
    return candidates.filter(e => !candidates.some(p => p !== e && p.contains(e)));
  };
  if (!document.querySelector(${JSON.stringify(ROW_SELECTOR)})) return within(document).slice(-300)[${index}];
  const row = document.querySelector(${JSON.stringify(`${ROW_SELECTOR}[data-index="`)} + ${index} + '"]');
  return row ? within(row)[0] : undefined;
})()`;

/**
 * Moves the remote transcript one step towards a row. "mounted" means the row exists now, "moved"
 * means look again shortly, and "none" means this page has no virtualized transcript. The step
 * places the nearest mounted row at the far edge of the viewport, so a very tall row cannot stall it.
 */
export function rowScrollExpression(row: number): string {
  return `(() => {
    const scroller = document.querySelector(${JSON.stringify(SCROLLER_SELECTOR)});
    const rows = [...document.querySelectorAll(${JSON.stringify(ROW_SELECTOR)})]
      .map(element => ({ element, index: Number(element.getAttribute('data-index')) }))
      .filter(item => Number.isInteger(item.index))
      .sort((a, b) => a.index - b.index);
    if (!scroller || !rows.length) return 'none';
    if (rows.some(item => item.index === ${row})) return 'mounted';
    const cache = globalThis.${CHAT_CACHE_GLOBAL};
    if (cache && cache.home === undefined) cache.home = scroller.scrollHeight - scroller.scrollTop;
    const top = scroller.getBoundingClientRect().top;
    scroller.scrollTop += ${row} < rows[0].index
      ? rows[0].element.getBoundingClientRect().top - top - scroller.clientHeight * 0.9
      : rows[rows.length - 1].element.getBoundingClientRect().bottom - top - scroller.clientHeight * 0.1;
    return 'moved';
  })()`;
}

/** Returns the transcript to where it was before reading older rows. */
export const SCROLL_HOME_EXPRESSION = `(() => {
  const cache = globalThis.${CHAT_CACHE_GLOBAL};
  const scroller = document.querySelector(${JSON.stringify(SCROLLER_SELECTOR)});
  if (!cache || cache.home === undefined) return false;
  if (scroller) scroller.scrollTop = scroller.scrollHeight - cache.home;
  cache.home = undefined;
  return true;
})()`;

/** Opens a document or artifact card on the remote page. */
export function cardOpenExpression(messageIndex: number, cardIndex: number): string {
  return `(() => {
    const message = ${findMessage(messageIndex)};
    const card = message && [...message.querySelectorAll('[data-file-row-card]')][${cardIndex}];
    const open = card && card.querySelector('[data-testid="frame-card-open"]');
    if (!open) return false;
    open.click();
    return true;
  })()`;
}

/** Opens one thinking/process row on the remote page; its detail then syncs like any change. */
export function stepExpandExpression(messageIndex: number, stepIndex: number): string {
  return `(() => {
    const message = ${findMessage(messageIndex)};
    const step = message && [...message.querySelectorAll('[class~="group/status"]')]
      .filter(s => !s.parentElement?.closest('[class~="group/status"]'))[${stepIndex}];
    const toggle = step && step.querySelector('button[aria-expanded]');
    if (!toggle) return false;
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    return true;
  })()`;
}

export function fileDownloadExpression(
  messageIndex: number,
  fileIndex: number,
  expectedName: string,
): string {
  return `(() => {
    const e = ${findMessage(messageIndex)};
    const a = e && (${FILE_CONTROLS})(e)[${fileIndex}];
    if (!a || a.disabled || (${FILE_NAME})(a) !== ${JSON.stringify(expectedName)}) return false;
    a.click(); return true;
  })()`;
}

/** Removes one attachment from the remote composer, unless the list has changed underneath it. */
export function attachmentRemoveExpression(index: number, expectedName: string): string {
  return String.raw`(() => {
    const tile = document.querySelectorAll(${JSON.stringify(ATTACHMENT_SELECTOR)})[${index}];
    const remove = tile && tile.querySelector(${JSON.stringify(ATTACHMENT_REMOVE_SELECTOR)});
    if (!remove) return false;
    const name = ((remove.getAttribute('aria-label') || '').replace(/^(remove|删除|移除)\s*/i, '') || tile.textContent || '附件').trim().slice(0, 200);
    if (name !== ${JSON.stringify(expectedName)}) return false;
    remove.click();
    return true;
  })()`;
}

const MODEL_TRIGGER = '[data-testid="model-selector-dropdown"]';
const centre = (element: string): string =>
  `(() => { const e = ${element}; if (!e) return null; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`;

export const MODEL_TRIGGER_POINT = centre(
  `document.querySelector(${JSON.stringify(MODEL_TRIGGER)})`,
);

/** The permission control follows the model control, among hidden copies of its other states. */
export const MODE_TRIGGER_POINT = centre(`(() => {
  const model = document.querySelector(${JSON.stringify(MODEL_TRIGGER)});
  const buttons = [...document.querySelectorAll('button')];
  return model && buttons.slice(buttons.indexOf(model) + 1, buttons.indexOf(model) + 4).find(b => b.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && (b.textContent || '').replace(/[\\uE000-\\uF8FF]/g, '').trim());
})()`);

const MODEL_MENUS = `[...document.querySelectorAll('[role="menu"]')]`;
const menuRow = (menu: string, label: string) =>
  `[...(${MODEL_MENUS}[${menu}]?.querySelectorAll('[role^="menuitem"]') || [])].find(item => (item.querySelector('span span span span')?.textContent || item.firstElementChild?.firstElementChild?.textContent || item.textContent || '').trim() === ${JSON.stringify(label)} || (item.textContent || '').trim().startsWith(${JSON.stringify(label)}))`;

/** Where a row of an open menu is: the model menu is the first, its submenu the second. */
export const modelRowPoint = (depth: 0 | 1, label: string): string =>
  centre(menuRow(String(depth), label));

export const MODEL_MENU_COUNT = `${MODEL_MENUS}.length`;

/** The rows of an open menu, without anything from the page beyond their words. */
export const modelMenuExpression = (depth: 0 | 1): string => `(() => {
  const menu = ${MODEL_MENUS}[${depth}];
  if (!menu) return null;
  const clean = value => (value || '').replace(/[\\uE000-\\uF8FF]/g, '').replace(/\\s+/g, ' ').trim();
  return [...menu.querySelectorAll('[role^="menuitem"]')].slice(0, 40).map(item => {
    const parts = [...item.querySelectorAll('span')].filter(span => !span.children.length).map(span => clean(span.textContent)).filter(Boolean);
    return { name: parts[0] || clean(item.textContent), detail: parts[1] || '', checked: item.getAttribute('aria-checked') === 'true', submenu: item.getAttribute('aria-haspopup') === 'menu' };
  }).filter(row => row.name);
})()`;

/** Brings Claude's sidebar to this state; it stays in the page's DOM either way. */
export function sidebarExpression(open: boolean): string {
  return `(() => {
    const toggle = document.querySelector('button[aria-keyshortcuts="Control+b"]');
    if (!toggle) return false;
    const closed = /show|显示|展开/i.test(toggle.getAttribute('aria-label') || '');
    if (closed === ${open}) toggle.click();
    return true;
  })()`;
}

const rowOfMessage = (index: number) => `(() => {
  const message = ${findMessage(index)};
  return message && (message.closest(${JSON.stringify(ROW_SELECTOR)}) || message.parentElement);
})()`;

/** Asks Claude for another reply, from a reply or from the user's message above one. */
export function retryExpression(index: number): string {
  return `(() => {
    const row = ${rowOfMessage(index)};
    const retry = row && row.querySelector('[data-testid="action-bar-retry"], [data-testid="user-message-retry"]');
    if (!retry) return false;
    retry.click();
    return true;
  })()`;
}

const editField = (index: number) =>
  `${rowOfMessage(index)}?.querySelector('textarea[data-cds="TextArea"]')`;

/** Opens the editor of a user message, unless that message is no longer the one on show. */
export function editOpenExpression(index: number, expected: string): string {
  return `(() => {
    const row = ${rowOfMessage(index)};
    const message = row && row.querySelector('[data-testid="user-message"]');
    const edit = row && row.querySelector('[data-testid="user-message-edit"]');
    if (!edit || message.textContent.replace(/\\s+/g, '') !== ${JSON.stringify(expected.replace(/\s+/g, ""))}) return false;
    edit.click();
    return true;
  })()`;
}

/** Fills the editor the way typing does, so that the page's own state follows. */
export function editFillExpression(index: number, text: string): string {
  return `(() => {
    const field = ${editField(index)};
    if (!field) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(text)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;
}

/** Presses Save, which is the last control beside the editor and enabled once the text differs. */
export function editSaveExpression(index: number): string {
  return `(() => {
    let box = ${editField(index)};
    while (box && box.querySelectorAll('button').length < 2) box = box.parentElement;
    const save = box && [...box.querySelectorAll('button')].pop();
    if (!save || save.disabled) return false;
    save.click();
    return true;
  })()`;
}
