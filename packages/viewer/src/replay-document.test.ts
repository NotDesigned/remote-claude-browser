// @vitest-environment node
import { describe, expect, it } from "vitest";
import { closeReplayDocument } from "./replay-document";

function fakeDocument(readyState: DocumentReadyState, doctype: string | null) {
  const calls: string[] = [];
  const doc = {
    readyState,
    doctype: doctype === null ? null : { serialized: doctype },
    defaultView: {
      XMLSerializer: class {
        serializeToString(node: { serialized: string }) {
          return node.serialized;
        }
      },
    },
    write(markup: string) {
      calls.push(`write ${markup}`);
    },
    close() {
      calls.push("close");
    },
  };
  return { doc: doc as unknown as Document, calls };
}

describe("closeReplayDocument", () => {
  it("hands the page's doctype to the open parser before closing it", () => {
    const { doc, calls } = fakeDocument("loading", "<!DOCTYPE html>");
    closeReplayDocument(doc);
    expect(calls).toEqual(["write <!DOCTYPE html>", "close"]);
  });

  it("keeps a page without a doctype in quirks mode", () => {
    const { doc, calls } = fakeDocument("loading", null);
    closeReplayDocument(doc);
    expect(calls).toEqual(["close"]);
  });

  it("never writes once the parser is closed, which would reopen and wipe the document", () => {
    const { doc, calls } = fakeDocument("complete", "<!DOCTYPE html>");
    closeReplayDocument(doc);
    expect(calls).toEqual(["close"]);
  });
});
