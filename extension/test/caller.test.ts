import { describe, expect, it } from "vitest";
import { callerInfo } from "../src/lib/caller";

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
});
