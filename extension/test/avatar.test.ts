import { describe, expect, it } from "vitest";
import { AVATAR_COLORS, avatarColor, avatarLetter } from "../src/ui/avatar";

describe("avatars", () => {
  it("are deterministic", () => {
    expect(avatarColor("GitHub")).toBe(avatarColor("github"));
    expect(AVATAR_COLORS).toContain(avatarColor("x"));
    expect(avatarLetter(" alice")).toBe("A");
    expect(avatarLetter("张三")).toBe("张");
    expect(avatarLetter("")).toBe("?");
  });
});
