/** Self-contained access page: no third-party requests or account credentials in the markup. */
export function renderGatePage(error?: string): string {
  const message =
    error === "Incorrect password."
      ? "访问密码不正确，请重新输入。"
      : error === "Too many attempts. Please wait and try again."
        ? "尝试次数较多，请稍后再试。"
        : error;
  const escaped = message?.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>登录 · Remote Workspace</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100svh;background:#f5f3ee;color:#282721;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
body:before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse at 12% 12%,#e9e6db88,transparent 55%),radial-gradient(ellipse at 92% 100%,#ead8cc55,transparent 48%)}
.shell{position:relative;max-width:1120px;min-height:100svh;margin:auto;padding:36px 48px;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:11px;font-size:15px;font-weight:650;letter-spacing:-.3px}.brand-mark{display:grid;place-items:center;width:34px;height:34px;background:#2e332c;border-radius:11px;color:#f5f3ee}.brand svg{width:20px;height:20px}
main{flex:1;display:grid;grid-template-columns:1.1fr 1fr;gap:84px;align-items:center;padding:70px 0 84px}
.eyebrow{display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:2.3px;color:#78796e;font-weight:650}.eyebrow:before{content:"";width:20px;height:1px;background:#a6a58e}
h1{font-family:Georgia,"Times New Roman",serif;font-size:clamp(42px,5.4vw,65px);line-height:1.12;font-weight:400;letter-spacing:-2.6px;margin:25px 0 23px}h1 em{color:#a75f45;font-weight:400}.intro p{color:#78786e;font-size:14px;line-height:1.9;max-width:350px;margin:0}
.note{display:flex;align-items:center;gap:12px;margin-top:39px;font-size:12px;color:#85867b}.note span{width:26px;height:1px;background:#c9c8b9}
.card{background:#fffefa;border:1px solid #e4e1d6;border-radius:22px;padding:38px 36px 30px;box-shadow:0 12px 38px -24px #45423355;max-width:420px;width:100%;justify-self:end}
.card-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:30px}.card-icon{width:42px;height:42px;display:grid;place-items:center;border:1px solid #e7e4da;background:#f8f7f1;border-radius:13px}.card-icon svg{width:20px;height:20px;stroke:#646953}.badge{font-size:11px;color:#737b64;display:flex;align-items:center;gap:6px}.badge:before{content:"";width:5px;height:5px;border-radius:50%;background:#7d8b65}
h2{font-size:25px;font-weight:550;letter-spacing:-.7px;margin:0 0 10px}.description{font-size:13px;line-height:1.7;color:#87877d;margin:0 0 29px}
label{display:block;font-size:12px;font-weight:600;margin-bottom:10px;color:#55574c}.field{position:relative}input{width:100%;height:50px;border:1px solid #dcdcd0;border-radius:10px;background:#fffefa;font:inherit;font-size:15px;letter-spacing:1px;padding:0 47px 0 14px;color:#30342b;outline:none;transition:border-color .15s,box-shadow .15s}input::placeholder{letter-spacing:0;color:#aaa99f;font-size:13px}input:focus{border-color:#859171;box-shadow:0 0 0 3px #85917119}input[aria-invalid=true]{border-color:#b76b50}
.reveal{position:absolute;right:7px;top:7px;width:36px;height:36px;display:grid;place-items:center;border:0;border-radius:7px;background:transparent;color:#929488;cursor:pointer}.reveal:hover{background:#f0f0e8;color:#565d4b}.reveal svg{width:18px;height:18px}.reveal:focus-visible,.submit:focus-visible{outline:3px solid #c3cdb3;outline-offset:3px}
.error{font-size:12px;line-height:1.6;color:#a3513d;margin:12px 0 0;padding:10px 12px;border-radius:8px;background:#faf0eb}.submit{height:49px;width:100%;margin-top:22px;display:flex;align-items:center;justify-content:center;gap:12px;border:0;border-radius:10px;background:#363e30;color:#fffefa;font:inherit;font-size:13px;font-weight:550;cursor:pointer;transition:background .15s,transform .15s}.submit:hover{background:#4a553f}.submit:active{transform:translateY(1px)}.submit svg{width:16px;height:16px}
.hint{border-top:1px solid #eeece3;margin:25px 0 0;padding-top:19px;font-size:11px;line-height:1.8;color:#99998e}.hint strong{font-weight:500;color:#777b6a}
footer{display:flex;justify-content:space-between;gap:12px;color:#9a9b90;font-size:10px;letter-spacing:.4px}footer span:last-child{letter-spacing:1.2px}
@media(max-width:760px){.shell{padding:26px 24px}main{grid-template-columns:1fr;gap:32px;padding:45px 0}.intro{max-width:420px;width:100%;justify-self:center}.intro h1{font-size:43px;margin:18px 0;letter-spacing:-1.7px}.intro p{font-size:13px}.note{display:none}.card{justify-self:center;padding:29px 25px 25px}.card-top{margin-bottom:24px}footer{font-size:9px}.eyebrow{font-size:10px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body><div class="shell">
<header class="brand"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M4 10h16M9 4v6m2 4 3 2-3 2"/></svg></span>Remote Workspace</header>
<main><section class="intro"><div class="eyebrow">A LITTLE SPACE TO FOCUS</div><h1>Your workspace,<br><em>one step away.</em></h1><p>留一点空间，给专注的对话。<br>输入访问密码，继续你的思考与创作。</p><div class="note"><span></span>对话 · 创作 · 思考</div></section>
<section class="card" aria-labelledby="login-title"><div class="card-top"><span class="card-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke-linecap="round"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></svg></span><span class="badge">安全访问入口</span></div>
<h2 id="login-title">欢迎回来</h2><p class="description">输入访问密码，进入远程工作台。</p>
<form method="post" action="/gate"><label for="access-password">访问密码</label><div class="field"><input id="access-password" name="password" type="password" required autocomplete="current-password" placeholder="输入你的访问密码" ${error ? 'aria-invalid="true" aria-describedby="login-error"' : ""}>
<button class="reveal" type="button" aria-label="显示密码" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg></button></div>
${escaped ? `<p id="login-error" class="error" role="alert">${escaped}</p>` : ""}
<button class="submit" type="submit">进入工作台<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 10h13m-5-5 5 5-5 5"/></svg></button></form>
<p class="hint">这里使用的是<strong>工作台访问密码</strong>，<br>无需输入 Claude 账号密码。</p></section></main>
<footer><span>claude.example.com</span><span>MAKE ROOM FOR GOOD IDEAS</span></footer></div>
<script>const field=document.getElementById('access-password');const reveal=document.querySelector('.reveal');reveal.addEventListener('click',()=>{const visible=field.type==='password';field.type=visible?'text':'password';reveal.setAttribute('aria-label',visible?'隐藏密码':'显示密码');reveal.setAttribute('aria-pressed',String(visible));});</script>
</body></html>`;
}
