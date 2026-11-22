import { describe, expect, it } from "vitest";
import { decodeBase32, hotp, parseTotp, totp } from "../src/lib/totp";
import { hex } from "./fixtures";

// RFC 6238 Appendix B seeds: ASCII "1234567890" repeated to 20, 32 and 64 bytes.
const SHA1_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const SHA256_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";
const SHA512_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA";
const ascii = (s: string) => hex(new TextEncoder().encode(s));

const params = (uri: string) => {
  const p = parseTotp(uri);
  expect(p, uri).not.toBeNull();
  return p!;
};

describe("decodeBase32", () => {
  it("decodes RFC 4648 base32 case-insensitively, ignoring spaces, dashes and trailing padding", () => {
    expect(hex(decodeBase32(SHA1_SEED)!)).toBe(ascii("12345678901234567890"));
    expect(hex(decodeBase32(SHA256_SEED)!)).toBe(ascii("12345678901234567890123456789012"));
    expect(hex(decodeBase32("gezd gnbv-gy3t qojq")!)).toBe(ascii("1234567890"));
    expect(hex(decodeBase32(" \tGEZDGNBVGY3TQOJQ\n")!)).toBe(ascii("1234567890"));
    expect(hex(decodeBase32("\fGEZD\vGNBV\rGY3T\nQOJQ\t ")!)).toBe(ascii("1234567890"));
    expect(hex(decodeBase32("GE======")!)).toBe("31");
    expect(hex(decodeBase32("GE=")!)).toBe("31");
    // RFC 4648 test vectors.
    for (const [encoded, text] of [["MY", "f"], ["MZXQ", "fo"], ["MZXW6", "foo"], ["MZXW6YQ", "foob"], ["MZXW6YTB", "fooba"], ["MZXW6YTBOI", "foobar"]]) {
      expect(hex(decodeBase32(encoded!)!)).toBe(ascii(text!));
    }
  });

  it("rejects other characters, padding inside, lengths no encoder produces and empty secrets", () => {
    for (const bad of ["", "   ", "-", "====", "G", "GEZ", "GEZDGN", "GEZDGNBVG", "GE1", "GE8A", "GE=A", "G=E", "GEZDGNBV========X", "GÉ", "0O"]) {
      expect([bad, decodeBase32(bad)]).toEqual([bad, null]);
    }
  });

  it("ignores only ASCII whitespace, and checks the letters before upper-casing them", () => {
    // String.prototype.trim() and \s would drop these; the server does not.
    for (const space of ["\u0085", "\ufeff", "\u00a0", "\u2028", "\u3000"]) {
      for (const bad of [`JBSWY3DP${space}EHPK3PXP`, `${space}JBSWY3DPEHPK3PXP`, `JBSWY3DPEHPK3PXP${space}`]) {
        expect([bad, decodeBase32(bad)]).toEqual([bad, null]);
      }
    }
    // Upper-casing turns U+00DF (sharp s) into "SS" and U+FB00 (the ff ligature) into "FF", but neither is base32.
    for (const bad of ["\u00df", "GEZDGNBV\u00df", "\ufb00"]) expect([bad, decodeBase32(bad)]).toEqual([bad, null]);
  });
});

describe("parseTotp", () => {
  it("reads a bare base32 secret with the defaults SHA1, 6 digits and 30 seconds", () => {
    expect(parseTotp(`  ${SHA1_SEED.toLowerCase()}  `)).toEqual({ secret: decodeBase32(SHA1_SEED), algorithm: "SHA1", digits: 6, period: 30 });
  });

  it("reads otpauth://totp/ URIs", () => {
    expect(parseTotp(`otpauth://totp/Example:alice@example.com?secret=${SHA1_SEED}&issuer=Example`)).toEqual({
      secret: decodeBase32(SHA1_SEED),
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });
    expect(parseTotp(`otpauth://totp/x?secret=${SHA512_SEED}&algorithm=SHA512&digits=8&period=60`)).toMatchObject({
      algorithm: "SHA512",
      digits: 8,
      period: 60,
    });
    expect(parseTotp(`otpauth://totp/x?period=300&digits=7&algorithm=sha256&secret=${SHA256_SEED}`)).toMatchObject({
      algorithm: "SHA256",
      digits: 7,
      period: 300,
    });
    expect(parseTotp(`otpauth://totp/x?secret=${SHA1_SEED}&period=1`)).toMatchObject({ period: 1 });
  });

  it("ignores case in the scheme, the type, parameter names and the algorithm", () => {
    expect(parseTotp(`OTPAUTH://TOTP/x?SECRET=${SHA1_SEED}&Algorithm=Sha256&DIGITS=8&Period=45`)).toMatchObject({
      algorithm: "SHA256",
      digits: 8,
      period: 45,
    });
  });

  it("decodes the secret like a bare one and lets a label, an empty label or none precede the query", () => {
    expect(hex(parseTotp("otpauth://totp/a%20b?secret=gezd%20gnbv-gy3t+qojq")!.secret)).toBe(ascii("1234567890"));
    expect(parseTotp(`otpauth://totp/?secret=${SHA1_SEED}`)).not.toBeNull();
    expect(parseTotp(`otpauth://totp?secret=${SHA1_SEED}`)).not.toBeNull();
  });

  it("treats empty optional parameters as absent and takes the first of a repeated one", () => {
    expect(parseTotp(`otpauth://totp/x?secret=${SHA1_SEED}&algorithm=&digits=&period=&issuer=`)).toMatchObject({
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });
    expect(parseTotp(`otpauth://totp/x?secret=${SHA1_SEED}&digits=8&DIGITS=6&period=60&period=30`)).toMatchObject({ digits: 8, period: 60 });
    expect(parseTotp(`otpauth://totp/x?secret=${SHA1_SEED}&Secret=GE`)!.secret).toEqual(decodeBase32(SHA1_SEED));
    expect(parseTotp(`otpauth://totp/x?secret=1&secret=${SHA1_SEED}`)).toBeNull();
  });

  it("reads the period as a whole number, leading zeros and all", () => {
    expect(parseTotp(`otpauth://totp/x?secret=${SHA1_SEED}&period=030`)).toMatchObject({ period: 30 });
    expect(parseTotp(`otpauth://totp/x?secret=${SHA1_SEED}&period=0300`)).toMatchObject({ period: 300 });
    expect(parseTotp(`otpauth://totp/x?secret=${SHA1_SEED}&period=0301`)).toBeNull();
  });

  it("trims only ASCII whitespace around the value", () => {
    expect(parseTotp(` \t\n\r\f\votpauth://totp/x?secret=${SHA1_SEED}&digits=8 \t\n\r\f\v`)).toMatchObject({ digits: 8 });
    for (const space of ["\u0085", "\ufeff", "\u00a0"]) {
      for (const bad of [`${space}otpauth://totp/x?secret=${SHA1_SEED}`, `${space}${SHA1_SEED}`, `otpauth://totp/x?secret=${SHA1_SEED}${space}`]) {
        expect([bad, parseTotp(bad)]).toEqual([bad, null]);
      }
    }
    expect(parseTotp(`otpauth://totp/x?secret=JBSWY3DP%C2%85EHPK3PXP`)).toBeNull();
  });

  it("rejects malformed values", () => {
    for (const bad of [
      "",
      "not base32!",
      "GEZ",
      "otpauth://totp/x",
      "otpauth://totp/x?secret=",
      "otpauth://totp/x?secret=GEZ",
      "otpauth://totp/x?issuer=Example",
      `otpauth://hotp/x?secret=${SHA1_SEED}&counter=1`,
      `otpauth://totp:80/x?secret=${SHA1_SEED}`,
      `otpauth:totp/x?secret=${SHA1_SEED}`,
      `otpauth:///totp/x?secret=${SHA1_SEED}`,
      `https://totp/x?secret=${SHA1_SEED}`,
      `otpauth://totp/x?secret=${SHA1_SEED}&algorithm=MD5`,
      `otpauth://totp/x?secret=${SHA1_SEED}&algorithm=SHA-1`,
      `otpauth://totp/x?secret=${SHA1_SEED}&algorithm=constructor`,
      `otpauth://totp/x?secret=${SHA1_SEED}&digits=5`,
      `otpauth://totp/x?secret=${SHA1_SEED}&digits=9`,
      `otpauth://totp/x?secret=${SHA1_SEED}&digits=6.0`,
      `otpauth://totp/x?secret=${SHA1_SEED}&digits=06`,
      `otpauth://totp/x?secret=${SHA1_SEED}&digits=+6`,
      `otpauth://totp/x?secret=${SHA1_SEED}&digits=%206`,
      `otpauth://totp/x?secret=${SHA1_SEED}&period=0`,
      `otpauth://totp/x?secret=${SHA1_SEED}&period=301`,
      `otpauth://totp/x?secret=${SHA1_SEED}&period=-30`,
      `otpauth://totp/x?secret=${SHA1_SEED}&period=30s`,
      `otpauth://totp/x?secret=${SHA1_SEED}&period=1e2`,
    ]) {
      expect([bad, parseTotp(bad)]).toEqual([bad, null]);
    }
  });
});

describe("RFC 6238 test vectors", () => {
  const seeds = { SHA1: SHA1_SEED, SHA256: SHA256_SEED, SHA512: SHA512_SEED };
  // Appendix B: unix seconds → [SHA1, SHA256, SHA512], 8 digits, 30-second steps.
  const vectors: Array<[number, string, string, string]> = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];

  it.each(vectors)("T=%is", async (seconds, ...codes) => {
    for (const [i, algorithm] of (["SHA1", "SHA256", "SHA512"] as const).entries()) {
      const p = params(`otpauth://totp/RFC6238?secret=${seeds[algorithm]}&algorithm=${algorithm}&digits=8`);
      expect([algorithm, (await totp(p, seconds * 1000 + 999)).code]).toEqual([algorithm, codes[i]]);
    }
  });

  it("keeps the leading zeros of shorter codes", async () => {
    // Fewer digits keep the last ones of the same truncated value.
    const at = 1111111109_000;
    expect((await totp(params(SHA1_SEED), at)).code).toBe("081804");
    expect((await totp(params(`otpauth://totp/x?secret=${SHA1_SEED}&digits=7`), at)).code).toBe("7081804");
  });

  it("matches RFC 4226 HOTP values", async () => {
    const p = params(SHA1_SEED);
    const codes = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((counter) => hotp(p, counter)));
    expect(codes).toEqual(["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"]);
  });

  it("counts past 32 bits", async () => {
    // Values from Node's createHmac; counter 5 alone gives 254676.
    expect(await hotp(params(SHA1_SEED), 2 ** 32 + 5)).toBe("250721");
    expect((await totp(params(`otpauth://totp/x?secret=${SHA1_SEED}&period=1&digits=8`), 2 ** 40 * 1000)).code).toBe("57445672");
  });
});

describe("totp", () => {
  it("counts the seconds left in the period", async () => {
    const p = params(SHA1_SEED);
    expect((await totp(p, 0)).remaining).toBe(30);
    expect((await totp(p, 29_999)).remaining).toBe(1);
    expect((await totp(p, 30_000)).remaining).toBe(30);
    expect((await totp(p, 59_000)).remaining).toBe(1);
    expect((await totp(params(`otpauth://totp/x?secret=${SHA1_SEED}&period=60`), 59_000)).remaining).toBe(1);
    expect((await totp(params(`otpauth://totp/x?secret=${SHA1_SEED}&period=60`), 61_500)).remaining).toBe(59);
  });

  it("uses T = floor(unix seconds / period)", async () => {
    const p = params(`otpauth://totp/x?secret=${SHA1_SEED}&period=60`);
    // T=1 for every second of 60–119.
    expect((await totp(p, 60_000)).code).toBe("287082");
    expect((await totp(p, 119_999)).code).toBe("287082");
    expect((await totp(p, 120_000)).code).toBe("359152");
    expect((await totp(params(SHA1_SEED), 29_999)).code).toBe("755224");
  });

  it("defaults to the current time", async () => {
    const p = params(SHA1_SEED);
    const before = await totp(p, Date.now());
    const now = await totp(p);
    const after = await totp(p, Date.now());
    expect([before.code, after.code]).toContain(now.code);
  });
});
