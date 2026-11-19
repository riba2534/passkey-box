import { isoCBOR } from "@simplewebauthn/server/helpers";
import { describe, expect, it } from "vitest";
import { encodeCbor, type CborValue } from "../src/lib/cbor";
import { hex } from "./fixtures";

describe("encodeCbor", () => {
  // RFC 8949 Appendix A
  it.each<[CborValue, string]>([
    [0, "00"],
    [1, "01"],
    [10, "0a"],
    [23, "17"],
    [24, "1818"],
    [25, "1819"],
    [100, "1864"],
    [1000, "1903e8"],
    [1000000, "1a000f4240"],
    [1000000000000, "1b000000e8d4a51000"],
    [-1, "20"],
    [-10, "29"],
    [-100, "3863"],
    [-1000, "3903e7"],
    [-257, "390100"],
    ["", "60"],
    ["a", "6161"],
    ["IETF", "6449455446"],
    ["ü", "62c3bc"],
    [new Uint8Array(), "40"],
    [new Uint8Array([1, 2, 3, 4]), "4401020304"],
    [[], "80"],
    [[1, 2, 3], "83010203"],
    [{}, "a0"],
    [{ a: 1, b: [2, 3] }, "a26161016162820203"],
    [true, "f5"],
    [false, "f4"],
    [null, "f6"],
  ])("encodes %j as %s", (value, expected) => {
    expect(hex(encodeCbor(value))).toBe(expected);
  });

  it("uses length-first canonical key order", () => {
    const map = new Map<number | string, CborValue>([
      ["aa", 0],
      [-1, 0],
      ["b", 0],
      [10, 0],
      [3, 0],
      [1, 0],
    ]);
    // 1 (01), 3 (03), 10 (0a), -1 (20), "b" (6162), "aa" (626161)
    expect(hex(encodeCbor(map))).toBe("a6" + "0100" + "0300" + "0a00" + "2000" + "616200" + "62616100");
  });

  it("orders attestationObject keys fmt, attStmt, authData", () => {
    const out = encodeCbor({ authData: new Uint8Array([1]), attStmt: {}, fmt: "none" });
    expect(hex(out)).toBe("a3" + "63666d74" + "646e6f6e65" + "6761747453746d74" + "a0" + "6861757468446174" + "61" + "4101");
  });

  it("long byte strings use the right length header", () => {
    expect(hex(encodeCbor(new Uint8Array(256))).slice(0, 6)).toBe("590100");
    expect(hex(encodeCbor(new Uint8Array(32))).slice(0, 4)).toBe("5820");
  });

  it("round-trips through an independent decoder", () => {
    const value = new Map<number | string, CborValue>([
      [1, 2],
      [-2, new Uint8Array([7, 8])],
      ["k", [true, null, "x"]],
    ]);
    const decoded = isoCBOR.decodeFirst<Map<unknown, unknown>>(encodeCbor(value));
    expect(decoded.get(1)).toBe(2);
    expect([...(decoded.get(-2) as Uint8Array)]).toEqual([7, 8]);
    expect(decoded.get("k")).toEqual([true, null, "x"]);
  });

  it("rejects unsupported values", () => {
    expect(() => encodeCbor(1.5)).toThrow(TypeError);
    expect(() => encodeCbor(Number.MAX_SAFE_INTEGER + 2)).toThrow(TypeError);
    expect(() => encodeCbor(undefined as unknown as CborValue)).toThrow(TypeError);
  });
});
