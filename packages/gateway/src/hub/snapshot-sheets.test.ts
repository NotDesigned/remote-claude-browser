import {
  EventType,
  decodeDown,
  resolveSheetRefs,
  type Down,
  type eventWithTime,
} from "@mirror/protocol";
import { describe, expect, it } from "vitest";
import { ViewerConn, type ViewerSocket } from "../ws/viewerconn";
import { encodeWithInlineSheets, externalizeSheets, sheetsOf } from "./snapshot-sheets";

const big = "a{color:red}".repeat(2000);
const event = (): eventWithTime =>
  ({
    type: EventType.FullSnapshot,
    timestamp: 1,
    data: {
      initialOffset: { top: 0, left: 0 },
      node: {
        type: 0,
        id: 1,
        childNodes: [
          {
            type: 2,
            id: 2,
            tagName: "link",
            attributes: { rel: "stylesheet", _cssText: big },
            childNodes: [],
          },
          { type: 2, id: 3, tagName: "style", attributes: { _cssText: "small{}" }, childNodes: [] },
          {
            type: 2,
            id: 4,
            tagName: "style",
            attributes: {},
            childNodes: [{ type: 3, id: 5, textContent: big, isStyle: true }],
          },
        ],
      },
    },
  }) as unknown as eventWithTime;
const message = (data: eventWithTime): Extract<Down, { t: "snapshot" }> => ({
  t: "snapshot",
  tab: "tab",
  epoch: 1,
  seq: 1,
  data: [data],
  reason: "resync",
});
const socket = () => {
  const sent: string[] = [];
  const value: ViewerSocket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (data: string | Uint8Array) => void sent.push(String(data)),
    close: () => {},
  } as unknown as ViewerSocket;
  return { sent, value };
};

describe("snapshot stylesheets", () => {
  it("moves only large sheets out and restores the original exactly", () => {
    const original = event();
    const external = externalizeSheets(original);
    const json = JSON.stringify(external);
    expect(json.length).toBeLessThan(600);
    expect(json).toContain("small{}");
    const sheets = sheetsOf(message(external))!;
    expect(sheets.size).toBe(1);
    expect(resolveSheetRefs([external], (hash) => sheets.get(hash))).toEqual([original]);
  });

  it("reports an unknown sheet instead of rendering without it", () => {
    expect(resolveSheetRefs([externalizeSheets(event())], () => undefined)).toBeNull();
  });

  it("leaves a snapshot without large sheets untouched", () => {
    const small = {
      ...event(),
      data: { ...(event().data as object), node: { type: 0, id: 1, childNodes: [] } },
    } as eventWithTime;
    expect(externalizeSheets(small)).toBe(small);
  });

  it("sends each sheet once per connection, before the snapshot that needs it", () => {
    const snapshot = message(externalizeSheets(event()));
    const { sent, value } = socket();
    const viewer = new ViewerConn(value, () => [], { knownSheets: [] });
    viewer.send(snapshot, JSON.stringify(snapshot));
    expect(sent.map((frame) => decodeDown(frame).t)).toEqual(["css", "snapshot"]);
    viewer.send(snapshot, JSON.stringify(snapshot));
    expect(sent.map((frame) => decodeDown(frame).t)).toEqual(["css", "snapshot", "snapshot"]);
  });

  it("skips sheets the client reported holding", () => {
    const snapshot = message(externalizeSheets(event()));
    const { sent, value } = socket();
    const viewer = new ViewerConn(value, () => [snapshot], {
      knownSheets: [...sheetsOf(snapshot)!.keys()],
    });
    viewer.sendJoinPayload();
    expect(sent.map((frame) => decodeDown(frame).t)).toEqual(["snapshot"]);
  });

  it("sends inline sheets to a client that did not offer to hold them", () => {
    const snapshot = message(externalizeSheets(event()));
    const { sent, value } = socket();
    new ViewerConn(value, () => [snapshot]).sendJoinPayload();
    expect(sent).toEqual([encodeWithInlineSheets(snapshot)]);
    expect(sent[0]).toContain(big);
  });
});
