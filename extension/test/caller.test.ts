import { describe, expect, it } from "vitest";
import { callerInfo, isHttpOrigin } from "../src/lib/caller";

describe("callerInfo", () => {
  it("top-level frames are same-origin", () => {
    expect(callerInfo({ origin: "https://a.test", hostname: "a.test", ancestorOrigins: [] })).toEqual({
      origin: "https://a.test",
      hostname: "a.test",
      crossOrigin: false,
    });
  });

  it("same-origin iframes are not cross-origin", () => {
    expect(callerInfo({ origin: "https://a.test", hostname: "a.test", ancestorOrigins: ["https://a.test"] }).crossOrigin).toBe(false);
  });

  it("cross-origin iframes report the top origin", () => {
    expect(
      callerInfo({ origin: "https://f.test", hostname: "f.test", ancestorOrigins: ["https://mid.test", "https://top.test"] }),
    ).toEqual({ origin: "https://f.test", hostname: "f.test", crossOrigin: true, topOrigin: "https://top.test" });
  });

  it("about:blank frames use the inherited origin", () => {
    expect(callerInfo({ origin: "null", hostname: "", ancestorOrigins: ["https://a.test"] }, "https://a.test")).toEqual({
      origin: "https://a.test",
      hostname: "a.test",
      crossOrigin: false,
    });
  });

  it("sandboxed frames keep the opaque origin and get no hostname", () => {
    expect(callerInfo({ origin: "null", hostname: "a.test", ancestorOrigins: ["https://a.test"] }, "null")).toEqual({
      origin: "null",
      hostname: "",
      crossOrigin: true,
      topOrigin: "https://a.test",
    });
    expect(callerInfo({ origin: "null", hostname: "a.test" }).hostname).toBe("");
  });

  it("isHttpOrigin accepts only serialized http(s) origins", () => {
    expect(isHttpOrigin("https://a.test")).toBe(true);
    expect(isHttpOrigin("http://localhost:18411")).toBe(true);
    expect(isHttpOrigin("null")).toBe(false);
    expect(isHttpOrigin("")).toBe(false);
    expect(isHttpOrigin("chrome-extension://abc")).toBe(false);
    expect(isHttpOrigin("file:///tmp/x.html")).toBe(false);
    expect(isHttpOrigin("https://a.test/path")).toBe(false);
  });
});
