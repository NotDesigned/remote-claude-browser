// @vitest-environment node
import { encodePxBinary, type Down } from "@mirror/protocol";
import { expect, it } from "vitest";
import { connectGateway, type WebSocketLike } from "./ws";

it("turns a binary pixel frame into a px message carrying a JPEG Blob", async () => {
  const socket: WebSocketLike = {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null,
    send: () => {},
    close: () => {},
  };
  const received: Down[] = [];
  const errors: Error[] = [];
  const gateway = connectGateway("wss://viewer.test/ws", (message) => received.push(message), {
    socketFactory: () => socket,
    onProtocolError: (error) => errors.push(error),
  });
  expect(socket.binaryType).toBe("arraybuffer");
  const jpeg = new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  const frame = encodePxBinary("tab-1", 640, 480, jpeg);
  socket.onmessage?.({
    data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength),
  });
  socket.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });
  expect(errors).toHaveLength(1);
  expect(received).toHaveLength(1);
  const px = received[0] as Extract<Down, { t: "px" }>;
  expect(px).toMatchObject({ t: "px", tab: "tab-1", w: 640, h: 480 });
  expect(px.data).toBeInstanceOf(Blob);
  expect(new Uint8Array(await (px.data as Blob).arrayBuffer())).toEqual(jpeg);
  gateway.close();
});
