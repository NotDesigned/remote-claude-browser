import { editableText } from "@mirror/protocol";

const MESSAGE_SELECTOR =
  '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-response';
const FILE_CONTROLS = String.raw`(e) => [...e.querySelectorAll('a[href], [data-testid="file-card-block"] button[aria-label]')].filter(a => a.tagName === 'BUTTON' ? /^(download\b|下载)/i.test(a.getAttribute('aria-label') || '') : a.hasAttribute('download') || /^(blob:|sandbox:)|download|attachment|\/files\//i.test(a.getAttribute('href') || '')).slice(0, 20)`;
const FILE_NAME = String.raw`(e) => (e.getAttribute('download') || (e.getAttribute('aria-label') || '').replace(/^(download\b|下载)\s*/i, '') || e.textContent || '下载文件').trim().slice(0, 200)`;

/** Read message text without forcing layout or including accessibility duplicates and controls. */
const MESSAGE_TEXT = String.raw`(element, rich = true) => {
  const skip = 'button, script, style, svg, .sr-only, [aria-hidden="true"], [data-testid="message-actions"], [data-testid="user-message-actions"]';
  const read = node => {
    if (node.nodeType === 3) {
      const text = node.textContent || '';
      return rich ? text.replace(/([\\\x60*_\[\]~$#>])/g, '\\$1') : text;
    }
    if (node.nodeType !== 1) return '';
    if (node.matches('.katex-display, .katex, math, mjx-container')) {
      const tex = (node.querySelector('annotation[encoding="application/x-tex"]')?.textContent || node.getAttribute('data-latex') || node.getAttribute('data-tex') || node.getAttribute('alttext') || '').trim();
      if (tex) { const block = node.matches('.katex-display, [display="block"], [display="true"]'); return block ? '\n$$\n' + tex + '\n$$\n' : '$' + tex + '$'; }
    }
    if (node.matches(skip)) return '';
    const tick = String.fromCharCode(96);
    if (node.tagName === 'PRE') return '\n' + tick.repeat(3) + '\n' + (node.querySelector('code')?.textContent || node.textContent || '') + '\n' + tick.repeat(3) + '\n';
    if (node.tagName === 'CODE' && node.parentElement?.tagName !== 'PRE') return tick + (node.textContent || '') + tick;
    if (node.tagName === 'BR') return '\n';
    const text = [...node.childNodes].map(read).join('');
    if (rich) {
      if (/^H[1-6]$/.test(node.tagName)) return '\n' + '#'.repeat(Number(node.tagName[1])) + ' ' + text.trim() + '\n\n';
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') || '';
        if (/^(https?:|mailto:|\/)/i.test(href)) {
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

/** Runs only in authoritative Chromium on B. No website scripts or HTML reach this UI. */
export const CHAT_EXPRESSION = String.raw`(() => {
  const visible = e => !!e && e.isConnected && !e.closest('[hidden], [inert], [aria-hidden="true"]');
  const editor = [...document.querySelectorAll('.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"], textarea[placeholder]')].find(visible);
  const candidates = [...document.querySelectorAll(${JSON.stringify(MESSAGE_SELECTOR)})];
  const messageText = ${MESSAGE_TEXT};
  const messages = candidates.filter(e => !candidates.some(p => p !== e && p.contains(e))).slice(-300).map((e, index) => ({
    id: e.closest('[data-message-id]')?.getAttribute('data-message-id') || String(index),
    role: e.matches('[data-testid="user-message"]') ? 'user' : 'assistant',
    text: messageText(e, !e.matches('[data-testid="user-message"]')),
    files: (${FILE_CONTROLS})(e).map((a, id) => ({ id: String(id), name: (${FILE_NAME})(a) }))
  }));
  const conversations = [...document.querySelectorAll('a[href^="/chat/"]')].map(e => ({path: new URL(e.href).pathname, title: (e.textContent || '').trim().slice(0, 150)})).filter(e => e.title && /^\/chat\/[a-zA-Z0-9-]+$/.test(e.path));
  const stop = [...document.querySelectorAll('button[aria-label], button[data-testid]')].find(e => /stop|停止/i.test((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('data-testid') || '')) && visible(e));
  const editorText = ${editableText.toString()};
  const draft = editor ? ('value' in editor ? editor.value : editorText(editor)) : '';
  return {url: location.href, title: document.title, ready: !!editor, draft: draft.trim() ? draft.slice(0, 100000) : '', generating: !!stop, messages, conversations: [...new Map(conversations.map(e => [e.path,e])).values()].slice(0,100)};
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

export function fileDownloadExpression(
  messageIndex: number,
  fileIndex: number,
  expectedName: string,
): string {
  return `(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(MESSAGE_SELECTOR)})];
    const messages = candidates.filter(e => !candidates.some(p => p !== e && p.contains(e))).slice(-300);
    const e = messages[${messageIndex}];
    const a = e && (${FILE_CONTROLS})(e)[${fileIndex}];
    if (!a || a.disabled || (${FILE_NAME})(a) !== ${JSON.stringify(expectedName)}) return false;
    a.click(); return true;
  })()`;
}
