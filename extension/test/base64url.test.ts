import { describe, expect, it } from "vitest";
import {
  base64urlToBytes,
  bufferSourceToBase64url,
  bufferSourceToBytes,
  bytesToBase64url,
  concatBytes,
  isBufferSource,
  utf8,
} from "../src/lib/base64url";

describe("base64url", () => {
  it.each([
    ["", ""],
    ["f", "Zg"],
    ["fo", "Zm8"],
    ["foo", "Zm9v"],
    ["foob", "Zm9vYg"],
    ["fooba", "Zm9vYmE"],
    ["foobar", "Zm9vYmFy"],
  ])("encodes RFC 4648 vector %j without padding", (text, encoded) => {
    expect(bytesToBase64url(utf8(text))).toBe(encoded);
    expect(new TextDecoder().decode(base64urlToBytes(encoded))).toBe(text);
  });

  it("uses the URL-safe alphabet", () => {
    expect(bytesToBase64url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("-_-_");
    expect([...base64urlToBytes("-_-_")]).toEqual([0xfb, 0xff, 0xbf]);
  });

  it("round-trips random and large buffers", () => {
    const data = new Uint8Array(70_000).map((_, i) => (i * 7919) & 0xff);
    expect(base64urlToBytes(bytesToBase64url(data))).toEqual(data);
  });

  it("accepts trailing padding but rejects invalid input", () => {
    expect([...base64urlToBytes("Zg==")]).toEqual([0x66]);
    expect(() => base64urlToBytes("Zm9v+")).toThrow(TypeError);
    expect(() => base64urlToBytes("Z")).toThrow(TypeError);
  });
});

describe("BufferSource helpers", () => {
  it("recognises ArrayBuffer and views only", () => {
    expect(isBufferSource(new ArrayBuffer(1))).toBe(true);
    expect(isBufferSource(new Uint8Array(1))).toBe(true);
    expect(isBufferSource(new DataView(new ArrayBuffer(2)))).toBe(true);
    expect(isBufferSource([1, 2])).toBe(false);
    expect(isBufferSource("abc")).toBe(false);
    expect(isBufferSource(null)).toBe(false);
  });

  it("respects byteOffset/byteLength of views and copies the data", () => {
    const backing = new Uint8Array([9, 1, 2, 3, 9]);
    const view = new Uint8Array(backing.buffer, 1, 3);
    const copy = bufferSourceToBytes(view);
    expect([...copy]).toEqual([1, 2, 3]);
    backing[1] = 7;
    expect(copy[0]).toBe(1);
    expect(bufferSourceToBase64url(new DataView(backing.buffer, 4, 1))).toBe("CQ");
    expect(bufferSourceToBase64url(new Uint8Array([1, 2]).buffer)).toBe("AQI");
  });

  it("throws TypeError for non-buffers", () => {
    expect(() => bufferSourceToBytes("challenge")).toThrow(TypeError);
  });

  it("concatenates", () => {
    expect([...concatBytes(new Uint8Array([1]), new Uint8Array(), new Uint8Array([2, 3]))]).toEqual([1, 2, 3]);
  });
});
