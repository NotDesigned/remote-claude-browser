import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml } from "./sanitize";

describe("sanitizeEmailHtml", () => {
  it("preserves layout tables, typography and styled CTA buttons while stripping all tracking vectors", () => {
    const raw = `<!doctype html>
      <?xml version="1.0" encoding="UTF-8"?>
      <!--[if mso]><img src="https://tracker.example/mso.png"><![endif]-->
      <![if !mso]><span style="display:none">preheader</span><![endif]>
      <html>
      <head>
        <title>Hidden Email Title</title>
        <link rel="preconnect" href="https://tracker.example">
        <meta http-equiv="refresh" content="0;url=https://tracker.example/escape">
        <style>
          @import "https://tracker.example/leak.css";
          @font-face { font-family: Leak; src: url(https://tracker.example/f.woff2); }
          body { background-color: #f7f7f8; font-family: sans-serif; background-image: url(https://tracker.example/bg.png); }
          .cta { background-color: #d97757; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block; }
          .sneaky { background: u\\72l(https://tracker.example/escaped.png); color: #222; }
        </style>
      </head>
      <body bgcolor="#f7f7f8">
        <script>fetch("https://tracker.example/js")</script>
        <img src="https://tracker.example/1x1.gif?uid=42" width="1" height="1" alt="Tracker">
        <img src="https://claude.ai/logo.png" width="120" height="32" alt="Anthropic">
        <table width="100%" cellpadding="16" background="https://tracker.example/table-bg.png">
          <tr>
            <td style="color: #111; background: url(https://tracker.example/td.png); padding: 20px">
              <h2>Sign in to Claude</h2>
              <p>Code: <strong>849201</strong></p>
              <a class="cta" href="https://claude.ai/magic-link#tok=99" ping="https://tracker.example/ping" onclick="alert(1)">Sign in</a>
              <p>Fallback: https://claude.ai/magic-link#tok=99.</p>
              <a href="javascript:alert(1)">Bad link</a>
              <a href="http://127.0.0.1:3010/internal">Internal link</a>
              <div title="a > b" style="color: #333; background: image('/logout'); border-image: src('/logout')">Quoted gt</div>
            </td>
          </tr>
        </table>
        <svg><image href="https://tracker.example/svg.png"/></svg>
        <iframe src="https://tracker.example/frame"></iframe>
        <style>body { background: url(https://tracker.example/unclosed-tail); }
      </body>
      </html>`;

    const clean = sanitizeEmailHtml(raw)!;
    expect(clean).toBeTruthy();
    // Zero tracking URLs, images, scripts, frames, doctype/XML declarations, or raw anchors survive
    expect(clean.toLowerCase()).not.toContain("doctype");
    expect(clean.toLowerCase()).not.toContain("<?xml");
    expect(clean).not.toContain("Hidden Email Title");
    expect(clean).not.toContain("tracker.example");
    expect(clean).not.toContain("<img");
    expect(clean).not.toContain("<script");
    expect(clean).not.toContain("<iframe");
    expect(clean).not.toContain("<svg");
    expect(clean).not.toContain("<link");
    expect(clean).not.toContain("<meta");
    expect(clean).not.toContain("<a ");
    expect(clean).not.toContain("href=");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("ping=");
    expect(clean).not.toContain("javascript:");
    expect(clean).not.toContain("url(");
    expect(clean).not.toContain("image(");
    expect(clean).not.toContain("src(");
    expect(clean).not.toContain("/logout");
    expect(clean).not.toContain("127.0.0.1");
    expect(clean).not.toContain("unclosed-tail");
    expect(clean).toContain('<div style="color:#333">Quoted gt</div>');

    // Meaningful non-pixel alt text, table layout, styles, code, and remote-link buttons stay intact
    expect(clean).toContain('<span class="mail-img-alt">Anthropic</span>');
    expect(clean).toContain("<strong>849201</strong>");
    expect(clean).toContain(".mail-canvas{background-color:#f7f7f8;font-family:sans-serif}");
    expect(clean).toContain(".cta{background-color:#d97757;color:#ffffff;padding:12px 24px");
    expect(clean).toContain(
      '<button type="button" class="mail-remote-link cta" data-mail-url="https://claude.ai/magic-link#tok=99">Sign in</button>',
    );
  });

  it("rejects IPv4-mapped IPv6, NAT64, and trailing-dot localhost link targets", () => {
    const clean = sanitizeEmailHtml(
      [
        '<a href="https://[::ffff:127.0.0.1]/admin">v4map</a>',
        '<a href="https://[0:0:0:0:0:ffff:10.0.0.1]/admin">v4priv</a>',
        '<a href="https://[64:ff9b::127.0.0.1]/admin">nat64</a>',
        '<a href="https://localhost./admin">localdot</a>',
        '<a href="https://claude.ai/login">safe</a>',
      ].join(" "),
    )!;
    expect(clean).not.toContain("7f00:1");
    expect(clean).not.toContain("a00:1");
    expect(clean).not.toContain("64:ff9b");
    expect(clean).not.toContain("localhost.");
    expect(clean).toContain('data-mail-url="https://claude.ai/login"');
  });
});
