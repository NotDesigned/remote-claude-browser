// Isolated access-form fixture only; does not contact the authenticated browser.
import { createRequire } from "node:module";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { createAccessGate } from "../packages/gateway/src/auth/access-gate";
import { registerSecurityHeaders } from "../packages/gateway/src/security-headers";
if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");
const Fastify = createRequire(new URL("../packages/gateway/package.json", import.meta.url))("fastify");
const watchdog=setTimeout(()=>process.exit(124),60000);
const app=Fastify();registerSecurityHeaders(app);
const gate=createAccessGate({password:"fixture-password",secret:Buffer.alloc(32,7),backoffMs:1});
app.addHook("preHandler",gate.preHandler);gate.registerRoutes(app);
app.get("/",async()=>"Fixture workspace");
await app.listen({host:"127.0.0.1",port:0});
const address=app.server.address() as {port:number};
const origin=`http://127.0.0.1:${address.port}`;
const browser=await chromium.launch({executablePath:"/opt/claude-test-chrome/chrome",headless:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:850}});
 const external:string[]=[];page.on("request",r=>{if(!r.url().startsWith(origin))external.push(r.url());});
 await page.goto(origin+"/gate");
 await page.screenshot({path:"artifacts/login-desktop.png",fullPage:true});
 await page.getByLabel("访问密码",{exact:true}).fill("fixture-password");
 await page.getByRole("button",{name:"显示密码"}).click();
 assert.equal(await page.locator("#access-password").getAttribute("type"),"text");
 await page.getByRole("button",{name:"隐藏密码"}).click();
 await page.locator("#access-password").fill("incorrect");
 await page.getByRole("button",{name:"进入工作台"}).click();
 await page.getByRole("alert").waitFor();
 assert.match(await page.getByRole("alert").innerText(),/访问密码不正确/);
 await page.setViewportSize({width:390,height:844});
 await page.goto(origin+"/gate");
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:"artifacts/login-mobile.png",fullPage:true});
 const ok=await page.request.post(origin+"/gate",{form:{password:"fixture-password"},maxRedirects:0});
 assert.equal(ok.status(),303);assert.ok(ok.headers()["set-cookie"]);
 assert.deepEqual(external,[]);
 console.log(JSON.stringify({desktopAndMobile:true,passwordReveal:true,wrongPasswordFeedback:true,correctPasswordRedirect:true,noExternalAssets:true}));
}finally{await browser.close();await app.close();clearTimeout(watchdog);}
