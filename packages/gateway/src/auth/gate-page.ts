/** Self-contained access page. */
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

export function renderGatePage(error?: string, oidcLabel?: string): string {
  const escaped = error === undefined ? undefined : escapeHtml(error);
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>登录</title>
<style>
:root {
  color-scheme: light;
  --paper: #f8f6f0;
  --ink: #2b2520;
  --muted: #6e655c;
  --line: #d9d3c9;
  --accent: #9f553d;
  font-family: "Instrument Sans", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
}
* { box-sizing: border-box; }
body {
  display: grid;
  place-items: center;
  margin: 0;
  min-height: 100svh;
  padding: clamp(24px, 6vh, 60px) 24px;
  background: var(--paper);
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
}
.login { width: min(100%, 328px); }
h1 {
  margin: 0 0 24px;
  font-size: 28px;
  font-weight: 600;
  line-height: 1.25;
}
form { display: grid; gap: 15px; }
.field { display: grid; gap: 6px; min-width: 0; }
label { font-size: 13px; font-weight: 550; }
.password { position: relative; }
input, button { font: inherit; }
input {
  width: 100%;
  height: 49px;
  padding: 0 13px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: #fffdfa;
  color: var(--ink);
  font-size: 16px;
  outline: none;
  transition: border-color 140ms, box-shadow 140ms;
}
#access-password { padding-right: 54px; }
input[aria-invalid="true"] { border-color: var(--accent); }
input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px #9f553d22; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.reveal {
  position: absolute;
  top: 3px;
  right: 3px;
  display: grid;
  place-items: center;
  width: 43px;
  height: 43px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.reveal:hover { background: #f4eee5; }
.reveal svg { width: 18px; height: 18px; }
.eye-slash { display: none; }
.reveal[aria-pressed="true"] .eye-slash { display: block; }
.error {
  margin: 0;
  padding: 9px 11px;
  border-radius: 8px;
  background: #f6e9e1;
  color: #86402f;
  font-size: 13px;
  line-height: 1.5;
}
.submit {
  position: relative;
  width: 100%;
  height: 49px;
  margin-top: 2px;
  border: 0;
  border-radius: 9px;
  background: #342b25;
  color: #fffdfa;
  font-size: 14px;
  font-weight: 550;
  cursor: pointer;
  transition: background 160ms, transform 160ms;
}
.submit:hover { background: #47382e; }
.submit:active { transform: scale(.988); }
.spinner { display: none; }
.submitting .submit { background: #5c4437; cursor: wait; }
.submitting .spinner {
  position: absolute;
  right: 16px;
  top: 16px;
  display: block;
  width: 16px;
  height: 16px;
  border: 2px solid #fffdfa55;
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 650ms linear infinite;
}
@keyframes spin { to { transform: rotate(1turn); } }
.divider {
  display: flex; align-items: center; gap: 10px; margin: 18px 0 12px;
  color: #8a7a6c; font-size: 13px;
}
.divider::before, .divider::after { content: ""; flex: 1; border-top: 1px solid #e3d9cc; }
.sso {
  display: flex; align-items: center; justify-content: center; min-height: 44px;
  border: 1px solid #cbbfb1; border-radius: 10px; color: #33271f; background: #fffaf3;
  text-decoration: none; font-weight: 600;
}
.sso:hover { background: #f4eee5; }
.sso:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.screen-reader-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  input, .submit, .submitting .spinner { animation: none; transition: none; }
  .submit:active { transform: none; }
}
</style>
</head><body>
<main class="login">
  <h1>登录</h1>
  <form method="post" action="/gate">
    <div class="field">
      <label for="access-username">用户名</label>
      <input id="access-username" name="username" type="text" required maxlength="64" autocomplete="username" autocapitalize="none" spellcheck="false">
    </div>
    <div class="field">
      <label for="access-password">密码</label>
      <div class="password">
        <input id="access-password" name="password" type="password" required autocomplete="current-password" ${error ? 'aria-invalid="true" aria-describedby="login-error"' : ""}>
        <button class="reveal" type="button" aria-label="显示密码" aria-pressed="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/>
            <circle cx="12" cy="12" r="2.5"/>
            <path class="eye-slash" d="m4 4 16 16"/>
          </svg>
        </button>
      </div>
    </div>
    ${escaped ? `<p id="login-error" class="error" role="alert">${escaped}</p>` : ""}
    <button class="submit" type="submit">
      <span class="submit-label">登录</span>
      <span class="spinner" aria-hidden="true"></span>
    </button>
  </form>
  ${
    oidcLabel
      ? `<p class="divider" aria-hidden="true"><span>或</span></p>
  <a class="sso" href="/gate/oidc/start">${escapeHtml(oidcLabel)}</a>`
      : ""
  }
  <span class="screen-reader-only" role="status"></span>
</main>
<script>
const password = document.getElementById('access-password');
const reveal = document.querySelector('.reveal');
reveal.addEventListener('click', () => {
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  reveal.setAttribute('aria-pressed', String(visible));
});

const form = document.querySelector('form');
const submit = form.querySelector('.submit');
const label = submit.querySelector('.submit-label');
const status = document.querySelector('[role="status"]');
const setSubmitting = (active) => {
  document.body.classList.toggle('submitting', active);
  submit.disabled = active;
  label.textContent = active ? '登录中…' : '登录';
  status.textContent = active ? '正在登录工作台' : '';
};
form.addEventListener('submit', () => setSubmitting(true));
window.addEventListener('pageshow', () => setSubmitting(false));
</script>
</body></html>`;
}
