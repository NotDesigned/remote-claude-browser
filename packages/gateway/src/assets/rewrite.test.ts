import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";
import { describe, expect, it } from "vitest";
import {
  createRewriteStage,
  portableMaskClip,
  portableSupports,
  rewriteCssText,
  rewriteSrcset,
} from "./rewrite";
import { openAssetToken, type AssetRef } from "./token";

const KEY = Buffer.alloc(32, 0x5a);
const CTX = { sessionId: "session / one", tabId: "tab-3" };

function event(value: unknown): eventWithTime {
  return value as eventWithTime;
}

function proxiedRef(value: string): AssetRef {
  const match = /^\/s\/session%20%2F%20one\/a\/([A-Za-z0-9_-]+)$/.exec(value);
  if (match === null) throw new Error(`not a proxy URL: ${value}`);
  return openAssetToken(match[1]!, KEY);
}

function refsIn(value: string): AssetRef[] {
  return [...value.matchAll(/\/s\/session%20%2F%20one\/a\/([A-Za-z0-9_-]+)/g)].map((match) =>
    openAssetToken(match[1]!, KEY),
  );
}

function fullSnapshot(root: unknown): eventWithTime {
  return event({
    type: EventType.FullSnapshot,
    timestamp: 20,
    data: { node: root, initialOffset: { top: 0, left: 0 }, untouched: "sentinel" },
  });
}

describe("CSS URL parsing", () => {
  const wrap = (url: string) => `<${url}>`;

  it("rewrites url() in unquoted, single-quoted, and double-quoted forms", () => {
    const css =
      ".a{a:url(https://cdn.example/a.png);" +
      "b:url( 'https://cdn.example/a(b).png' );" +
      'c:URL( "https://cdn.example/c\\\"d.png" )}';

    expect(rewriteCssText(css, wrap)).toBe(
      ".a{a:url(<https://cdn.example/a.png>);" +
        "b:url( '<https://cdn.example/a(b).png>' );" +
        'c:URL( "<https://cdn.example/c%22d.png>" )}',
    );
  });

  it("rewrites quoted and url() @imports while preserving all surrounding CSS bytes", () => {
    const css =
      '@import/* keep */"theme/base.css" layer(theme);\n' +
      "@IMPORT url( '../print.css' ) print;\n" +
      "a { color: red; }";

    expect(rewriteCssText(css, wrap, "https://site.example/css/app/main.css")).toBe(
      '@import/* keep */"<https://site.example/css/app/theme/base.css>" layer(theme);\n' +
        "@IMPORT url( '<https://site.example/css/print.css>' ) print;\n" +
        "a { color: red; }",
    );
  });

  it("leaves data URLs, fragments, comments, and string literals byte-for-byte untouched", () => {
    const css =
      'a{one:url(data:image/svg+xml,%3Csvg%3E);two:url("data:image/png;base64,a,b");' +
      'mask:url(#local);content:"url(https://do-not-touch.example/a.png)"}' +
      "/* url(https://do-not-touch.example/b.png) */";

    expect(rewriteCssText(css, wrap, "https://site.example/page")).toBe(css);
  });

  it("decodes CSS escapes before sealing the target URL", () => {
    expect(rewriteCssText("a{background:url(https\\://cdn.example/a\\(b\\).png)}", wrap)).toBe(
      "a{background:url(<https://cdn.example/a(b).png>)}",
    );
  });
});

describe("srcset parsing", () => {
  it("keeps commas inside candidate URLs and preserves descriptors and separators", () => {
    const input = "https://img.example/a,b.png?crop=1,2 1x,\n  https://img.example/large.png 2x";
    const output = rewriteSrcset(input, (url) => `<${url}>`);

    expect(output).toBe(
      "<https://img.example/a,b.png?crop=1,2> 1x,\n  <https://img.example/large.png> 2x",
    );
  });

  it("passes through data candidates with commas while rewriting adjacent candidates", () => {
    const input = "data:image/png;base64,AAAA 1x, https://img.example/two.png 2x";
    expect(rewriteSrcset(input, (url) => `<${url}>`)).toBe(
      "data:image/png;base64,AAAA 1x, <https://img.example/two.png> 2x",
    );
  });
});

describe("rrweb RewriteStage", () => {
  it("leaves frames open to the replayer, which writes their documents itself", () => {
    const stage = createRewriteStage(KEY);
    const frame = {
      type: 2,
      id: 7,
      tagName: "iframe",
      attributes: { sandbox: "allow-scripts", srcdoc: "<p>x</p>", title: "Doc" },
      childNodes: [],
    };
    const snapshot = stage(
      event({ type: EventType.FullSnapshot, timestamp: 1, data: { node: frame } }),
      CTX,
    ) as unknown as { data: { node: { attributes: unknown } } };
    expect(snapshot.data.node.attributes).toEqual({ title: "Doc" });

    const later = stage(
      event({
        type: EventType.IncrementalSnapshot,
        timestamp: 2,
        data: {
          source: IncrementalSource.Mutation,
          adds: [{ parentId: 1, nextId: null, node: frame }],
          attributes: [{ id: 7, attributes: { sandbox: "allow-scripts" } }],
          removes: [],
          texts: [],
        },
      }),
      CTX,
    ) as unknown as {
      data: { adds: { node: { attributes: unknown } }[]; attributes: { attributes: unknown }[] };
    };
    expect(later.data.adds[0]!.node.attributes).toEqual({ title: "Doc" });
    expect(later.data.attributes[0]!.attributes).toEqual({});
  });

  it("preserves media-object sources for RTC in snapshots and later mutations", () => {
    const stage = createRewriteStage(KEY);
    const src = "blob:https://video.example/mse";
    const snapshot = fullSnapshot({ type: 2, id: 7, tagName: "video", attributes: { src } });
    expect(stage(snapshot, CTX)).toEqual(snapshot);
    const mutation = event({
      type: EventType.IncrementalSnapshot,
      timestamp: 30,
      data: {
        source: IncrementalSource.Mutation,
        attributes: [{ id: 7, attributes: { src } }],
        adds: [],
        removes: [],
        texts: [],
      },
    });
    expect(stage(mutation, CTX)).toEqual(mutation);
  });

  it("uses a stable resource URL across duplicate nodes and resnapshots", () => {
    const stage = createRewriteStage(KEY);
    const source = fullSnapshot({
      type: 2,
      tagName: "img",
      attributes: { src: "https://cdn.example/page.png" },
    });
    expect(stage(source, CTX)).toEqual(stage(source, CTX));
    expect(stage(source, { ...CTX, tabId: "other" })).not.toEqual(stage(source, CTX));
  });

  it("proxies object URLs but leaves non-fetchable schemes alone", () => {
    const stage = createRewriteStage(KEY);
    const source = fullSnapshot({
      type: 2,
      tagName: "img",
      attributes: { src: "blob:https://reader.example/id" },
    });
    expect(JSON.stringify(stage(source, CTX))).toContain("/s/");
    expect(rewriteCssText("a{background:url(about:blank)}", () => "wrong")).toBe(
      "a{background:url(about:blank)}",
    );
  });

  it("rewrites an @font-face woff2 URL to a sealed session asset route", () => {
    const stage = createRewriteStage(KEY);
    stage(
      event({
        type: EventType.Meta,
        timestamp: 1,
        data: { href: "https://fonts.example/css/families.css", width: 800, height: 600 },
      }),
      CTX,
    );
    const original = fullSnapshot({
      type: 2,
      id: 1,
      tagName: "style",
      attributes: {
        _cssText:
          "@font-face{font-family:'Server Sans';font-style:normal;" +
          "src:url(../files/server-sans.woff2) format('woff2')}",
      },
      childNodes: [],
    });
    const rewritten = stage(original, CTX) as unknown as {
      data: { node: { attributes: { _cssText: string } } };
    };
    const css = rewritten.data.node.attributes._cssText;
    const [ref] = refsIn(css);

    expect(ref).toEqual({
      url: "https://fonts.example/files/server-sans.woff2",
      ...CTX,
    });
    expect(css).toMatch(/src:url\(\/s\/session%20%2F%20one\/a\/[A-Za-z0-9_-]+\)/);
    expect(css).toContain("format('woff2')");
  });

  it("rewrites the separate rrweb collectFonts event for a string-backed FontFace", () => {
    const original = event({
      type: EventType.IncrementalSnapshot,
      timestamp: 15,
      data: {
        source: IncrementalSource.Font,
        family: "Constructor Sans",
        fontSource: "url(https://fonts.example/constructor.woff2)",
        descriptors: { weight: "600" },
        buffer: false,
      },
    });
    const rewritten = createRewriteStage(KEY)(original, CTX) as unknown as {
      data: Record<string, any>;
    };

    expect(refsIn(rewritten.data.fontSource)).toEqual([
      { url: "https://fonts.example/constructor.woff2", ...CTX },
    ]);
    expect(rewritten.data.family).toBe("Constructor Sans");
    expect(rewritten.data.descriptors).toEqual({ weight: "600" });
    expect(rewritten.data.buffer).toBe(false);
  });

  it("rewrites FullSnapshot attributes, inline SVG, inline styles, and stylesheet text", () => {
    const original = fullSnapshot({
      type: 0,
      id: 1,
      childNodes: [
        {
          type: 2,
          id: 2,
          tagName: "img",
          attributes: {
            src: "https://img.example/photo.png",
            srcset: "https://img.example/a,b.png 1x, https://img.example/two.png 2x",
            poster: "data:image/png;base64,a,b",
            style:
              "background:url( 'https://img.example/a(b).png' );cursor:url(data:image/png;base64,a,b),auto",
            href: "https://navigation.example/untouched",
            onclick: "window.staysExactlyAsRecorded()",
          },
          childNodes: [],
        },
        {
          type: 2,
          id: 3,
          tagName: "svg",
          attributes: { viewBox: "0 0 10 10" },
          childNodes: [
            {
              type: 2,
              id: 4,
              tagName: "image",
              isSVG: true,
              attributes: { "xlink:href": "https://img.example/vector.png", fill: "red" },
              childNodes: [],
            },
          ],
        },
        {
          type: 2,
          id: 5,
          tagName: "style",
          attributes: {
            nonce: "untouched",
            _cssText: '@import "https://css.example/base.css";i{src:url(icon.woff2)}',
          },
          childNodes: [
            {
              type: 3,
              id: 6,
              textContent: "b{background:url(https://css.example/body.png)}",
            },
          ],
        },
      ],
    });
    const before = structuredClone(original);
    const stage = createRewriteStage(KEY);
    stage(
      event({
        type: EventType.Meta,
        timestamp: 10,
        data: { href: "https://page.example/path/index.html", width: 800, height: 600 },
      }),
      CTX,
    );
    const rewritten = stage(original, CTX) as unknown as {
      data: { node: { childNodes: Array<Record<string, any>> }; untouched: string };
    };

    expect(original).toEqual(before);
    expect(rewritten.data.untouched).toBe("sentinel");
    const image = rewritten.data.node.childNodes[0]!;
    expect(proxiedRef(image.attributes.src)).toEqual({
      url: "https://img.example/photo.png",
      ...CTX,
    });
    expect(refsIn(image.attributes.srcset).map((ref) => ref.url)).toEqual([
      "https://img.example/a,b.png",
      "https://img.example/two.png",
    ]);
    expect(image.attributes.srcset.replace(/\/s\/[^ ]+\/a\/[A-Za-z0-9_-]+/g, "PROXY")).toBe(
      "PROXY 1x, PROXY 2x",
    );
    expect(image.attributes.poster).toBe("data:image/png;base64,a,b");
    expect(refsIn(image.attributes.style).map((ref) => ref.url)).toEqual([
      "https://img.example/a(b).png",
    ]);
    expect(image.attributes.style).toContain("url(data:image/png;base64,a,b)");
    expect(image.attributes.href).toBe("https://navigation.example/untouched");
    expect(image.attributes.onclick).toBe("window.staysExactlyAsRecorded()");

    const svgImage = rewritten.data.node.childNodes[1]!.childNodes[0]!;
    expect(proxiedRef(svgImage.attributes["xlink:href"]).url).toBe(
      "https://img.example/vector.png",
    );
    expect(svgImage.attributes.fill).toBe("red");

    const style = rewritten.data.node.childNodes[2]!;
    expect(refsIn(style.attributes._cssText).map((ref) => ref.url)).toEqual([
      "https://css.example/base.css",
      "https://page.example/path/icon.woff2",
    ]);
    expect(refsIn(style.childNodes[0].textContent).map((ref) => ref.url)).toEqual([
      "https://css.example/body.png",
    ]);
    expect(style.attributes.nonce).toBe("untouched");
  });

  it("rewrites mutation attributes and recursively rewrites added-node subtrees", () => {
    const original = event({
      type: EventType.IncrementalSnapshot,
      timestamp: 30,
      data: {
        source: IncrementalSource.Mutation,
        texts: [{ id: 99, value: "ordinary https://text.example stays" }],
        removes: [],
        attributes: [
          {
            id: 8,
            attributes: {
              src: "https://mut.example/new.png",
              title: "untouched",
              style: {
                backgroundImage: ["url(https://mut.example/bg.png)", "important"],
                color: "red",
                opacity: false,
              },
            },
          },
        ],
        adds: [
          {
            parentId: 1,
            nextId: null,
            node: {
              type: 2,
              id: 9,
              tagName: "section",
              attributes: { "data-owner": "site" },
              childNodes: [
                {
                  type: 2,
                  id: 10,
                  tagName: "img",
                  attributes: { src: "https://add.example/deep.png", alt: "kept" },
                  childNodes: [],
                },
                {
                  type: 2,
                  id: 11,
                  tagName: "style",
                  attributes: {},
                  childNodes: [
                    {
                      type: 3,
                      id: 12,
                      textContent: '@import "https://add.example/deep.css";',
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    const before = structuredClone(original);
    const rewritten = createRewriteStage(KEY)(original, CTX) as unknown as {
      data: Record<string, any>;
    };

    expect(original).toEqual(before);
    expect(proxiedRef(rewritten.data.attributes[0].attributes.src).url).toBe(
      "https://mut.example/new.png",
    );
    const style = rewritten.data.attributes[0].attributes.style;
    expect(refsIn(style.backgroundImage[0])[0]?.url).toBe("https://mut.example/bg.png");
    expect(style.backgroundImage[1]).toBe("important");
    expect(style.color).toBe("red");
    expect(style.opacity).toBe(false);
    expect(rewritten.data.texts).toEqual([
      { id: 99, value: "ordinary https://text.example stays" },
    ]);
    const added = rewritten.data.adds[0].node;
    expect(proxiedRef(added.childNodes[0].attributes.src).url).toBe("https://add.example/deep.png");
    expect(added.childNodes[0].attributes.alt).toBe("kept");
    expect(refsIn(added.childNodes[1].childNodes[0].textContent)[0]?.url).toBe(
      "https://add.example/deep.css",
    );
  });

  it("rewrites later text updates to an existing style node without mutating the input", () => {
    const stage = createRewriteStage(KEY);
    stage(
      event({
        type: EventType.Meta,
        timestamp: 1,
        data: { href: "https://page.example/app/index.html", width: 800, height: 600 },
      }),
      CTX,
    );
    const initial = fullSnapshot({
      type: 2,
      id: 2,
      tagName: "style",
      attributes: {},
      childNodes: [{ type: 3, id: 3, textContent: ".icon{color:red}" }],
    });
    expect(stage(initial, CTX)).toBe(initial);
    const original = event({
      type: EventType.IncrementalSnapshot,
      timestamp: 30,
      data: {
        source: IncrementalSource.Mutation,
        attributes: [],
        adds: [],
        removes: [],
        texts: [{ id: 3, value: "@font-face{font-family:Icons;src:url(../fonts/icons.woff2)}" }],
      },
    });
    const before = structuredClone(original);
    const rewritten = stage(original, CTX) as unknown as { data: Record<string, any> };

    expect(original).toEqual(before);
    expect(refsIn(rewritten.data.texts[0].value)).toEqual([
      { url: "https://page.example/fonts/icons.woff2", ...CTX },
    ]);
    expect(rewritten.data.texts[0].id).toBe(3);
    expect(rewritten.data.texts[0].value).toContain("font-family:Icons");
  });

  it("rewrites text directly appended to an existing style and tracks its later updates", () => {
    const stage = createRewriteStage(KEY);
    stage(fullSnapshot({ type: 2, id: 2, tagName: "style", attributes: {}, childNodes: [] }), CTX);
    const original = event({
      type: EventType.IncrementalSnapshot,
      timestamp: 30,
      data: {
        source: IncrementalSource.Mutation,
        attributes: [],
        removes: [],
        texts: [],
        adds: [
          {
            parentId: 2,
            nextId: null,
            node: { type: 3, id: 3, textContent: '@import "https://css.example/theme.css";' },
          },
        ],
      },
    });
    const before = structuredClone(original);
    const appended = stage(original, CTX) as unknown as { data: Record<string, any> };
    expect(original).toEqual(before);
    expect(refsIn(appended.data.adds[0].node.textContent)).toEqual([
      { url: "https://css.example/theme.css", ...CTX },
    ]);
    expect(appended.data.adds[0].parentId).toBe(2);

    const updated = stage(
      event({
        type: EventType.IncrementalSnapshot,
        timestamp: 31,
        data: {
          source: IncrementalSource.Mutation,
          attributes: [],
          removes: [],
          adds: [],
          texts: [{ id: 3, value: ".icon{background:url(https://css.example/icon.png)}" }],
        },
      }),
      CTX,
    ) as unknown as { data: Record<string, any> };
    expect(refsIn(updated.data.texts[0].value)).toEqual([
      { url: "https://css.example/icon.png", ...CTX },
    ]);
  });

  it("preserves CSS-like conversation text and input values while rewriting known style text", () => {
    const stage = createRewriteStage(KEY);
    stage(
      fullSnapshot({
        type: 0,
        id: 1,
        childNodes: [
          {
            type: 2,
            id: 2,
            tagName: "style",
            attributes: {},
            childNodes: [{ type: 3, id: 3, textContent: "" }],
          },
          {
            type: 2,
            id: 4,
            tagName: "p",
            attributes: {},
            childNodes: [{ type: 3, id: 5, textContent: "" }],
          },
          { type: 2, id: 6, tagName: "input", attributes: { value: "" }, childNodes: [] },
          {
            type: 2,
            id: 7,
            tagName: "textarea",
            attributes: {},
            childNodes: [{ type: 3, id: 8, textContent: "" }],
          },
        ],
      }),
      CTX,
    );
    const prose = ".icon{background:url(https://conversation.example/leave-this.png)}";
    const original = event({
      type: EventType.IncrementalSnapshot,
      timestamp: 30,
      data: {
        source: IncrementalSource.Mutation,
        adds: [],
        removes: [],
        attributes: [{ id: 6, attributes: { value: prose } }],
        texts: [
          { id: 3, value: ".icon{background:url(https://css.example/icon.png)}" },
          { id: 5, value: prose },
          { id: 8, value: prose },
          { id: 99, value: prose },
        ],
      },
    });
    const before = structuredClone(original);
    const rewritten = stage(original, CTX) as unknown as { data: Record<string, any> };
    expect(original).toEqual(before);
    expect(refsIn(rewritten.data.texts[0].value)).toEqual([
      { url: "https://css.example/icon.png", ...CTX },
    ]);
    expect(rewritten.data.texts.slice(1)).toEqual((original as any).data.texts.slice(1));
    expect(rewritten.data.attributes).toEqual((original as any).data.attributes);

    const input = event({
      type: EventType.IncrementalSnapshot,
      timestamp: 31,
      data: { source: IncrementalSource.Input, id: 6, text: prose, isChecked: false },
    });
    expect(stage(input, CTX)).toBe(input);
  });

  it("clears style text identities on each new full snapshot", () => {
    const stage = createRewriteStage(KEY);
    stage(
      fullSnapshot({
        type: 2,
        id: 2,
        tagName: "style",
        attributes: {},
        childNodes: [{ type: 3, id: 3, textContent: "" }],
      }),
      CTX,
    );
    stage(fullSnapshot({ type: 0, id: 1, childNodes: [] }), CTX);
    const ordinary = event({
      type: EventType.IncrementalSnapshot,
      timestamp: 30,
      data: {
        source: IncrementalSource.Mutation,
        adds: [],
        removes: [],
        attributes: [],
        texts: [{ id: 3, value: ".ordinary{background:url(https://text.example/untouched)}" }],
      },
    });
    expect(stage(ordinary, CTX)).toBe(ordinary);
  });

  it("covers rrweb CSSOM stylesheet rule mutations without touching unrelated event fields", () => {
    const original = event({
      type: EventType.IncrementalSnapshot,
      timestamp: 40,
      data: {
        source: IncrementalSource.StyleSheetRule,
        id: 20,
        adds: [
          { rule: "a{background:url(https://cssom.example/a.png)}", index: [0, 1] },
          { rule: "b{color:red}", index: 2 },
        ],
        removes: [{ index: 4 }],
        replace: '@import "https://cssom.example/base.css";',
      },
    });
    const rewritten = createRewriteStage(KEY)(original, CTX) as unknown as {
      data: Record<string, any>;
    };

    expect(refsIn(rewritten.data.adds[0].rule)[0]?.url).toBe("https://cssom.example/a.png");
    expect(rewritten.data.adds[0].index).toEqual([0, 1]);
    expect(rewritten.data.adds[1]).toBe((original as any).data.adds[1]);
    expect(refsIn(rewritten.data.replace)[0]?.url).toBe("https://cssom.example/base.css");
    expect(rewritten.data.removes).toBe((original as any).data.removes);
  });

  it("resolves relative resource URLs against the latest Meta URL per session and tab", () => {
    const stage = createRewriteStage(KEY);
    const meta = event({
      type: EventType.Meta,
      timestamp: 1,
      data: { href: "https://page.example/dir/document.html", width: 1, height: 1 },
    });
    expect(stage(meta, CTX)).toBe(meta);
    const rewritten = stage(
      fullSnapshot({
        type: 2,
        id: 1,
        tagName: "video",
        attributes: { poster: "../poster.png" },
        childNodes: [],
      }),
      CTX,
    ) as unknown as { data: { node: { attributes: { poster: string } } } };

    expect(proxiedRef(rewritten.data.node.attributes.poster)).toEqual({
      url: "https://page.example/poster.png",
      ...CTX,
    });
  });

  it("returns an event by identity when it contains no target URL fields", () => {
    const original = fullSnapshot({
      type: 2,
      id: 1,
      tagName: "a",
      attributes: { href: "https://navigation.example", title: "same" },
      childNodes: [{ type: 3, id: 2, textContent: "same" }],
    });
    expect(createRewriteStage(KEY)(original, CTX)).toBe(original);
  });
});

describe("portable @supports for the viewer's browser", () => {
  const clone =
    "@supports ((-webkit-mask-clip:text)) and (-webkit-app-region:drag) { .cds-root [data-cds-shimmer-clone] { mask-clip: text; position: absolute; } }";

  it("drops the Chromium-only app-region clause so Safari styles Chromium-created elements", () => {
    expect(portableSupports(clone)).toBe(
      "@supports ((-webkit-mask-clip:text)) { .cds-root [data-cds-shimmer-clone] { mask-clip: text; position: absolute; } }",
    );
    expect(
      portableSupports("@supports (-webkit-app-region: drag) and (display:grid) { a { b: c } }"),
    ).toBe("@supports (display:grid) { a { b: c } }");
    expect(rewriteCssText(clone, (url) => url)).not.toContain("app-region");
  });

  it("adds the WebKit prefix to text mask clipping, and only there", () => {
    expect(portableMaskClip("a { mask-clip: text; display: block; }")).toBe(
      "a { -webkit-mask-clip: text; mask-clip: text; display: block; }",
    );
    for (const css of ["a { -webkit-mask-clip: text; }", "a { mask-clip: border-box; }"])
      expect(portableMaskClip(css)).toBe(css);
    expect(rewriteCssText("a{mask-clip:text}", (url) => url)).toContain("-webkit-mask-clip: text");
  });

  it("leaves every other rule, and a condition that only tests app-region, untouched", () => {
    const plain = ".drag { -webkit-app-region: drag; } @supports (display:grid) { a { b: c } }";
    expect(portableSupports(plain)).toBe(plain);
    const only = "@supports (-webkit-app-region:drag) { .titlebar { height: 28px } }";
    expect(portableSupports(only)).toBe(only);
  });
});
