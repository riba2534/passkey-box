import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const staticDir = join(import.meta.dirname, "..", "static");
const manifest = JSON.parse(readFileSync(join(staticDir, "manifest.json"), "utf8"));
const { version } = JSON.parse(readFileSync(join(staticDir, "..", "package.json"), "utf8"));

describe("manifest.json (CONTRACT 4.2)", () => {
  it("identity and permissions", () => {
    expect(manifest).toMatchObject({ manifest_version: 3, name: "Passkey Box", version });
    expect(manifest.key).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(manifest.permissions).toEqual(["storage", "tabs"]);
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);
    expect(manifest.background).toEqual({ service_worker: "background.js", type: "module" });
    expect(manifest.action.default_popup).toBe("popup.html");
    expect(manifest.options_page).toBe("options.html");
  });

  it("content scripts: inject.js in MAIN, content.js in ISOLATED, both at document_start in all frames", () => {
    const scripts = manifest.content_scripts as Array<Record<string, unknown>>;
    expect(scripts).toHaveLength(2);
    for (const cs of scripts) {
      expect(cs).toMatchObject({ matches: ["<all_urls>"], run_at: "document_start", all_frames: true, match_about_blank: true });
    }
    expect(scripts[0]).toMatchObject({ js: ["inject.js"], world: "MAIN" });
    expect(scripts[1]!["js"]).toEqual(["content.js"]);
    expect(scripts[1]!["world"]).toBeUndefined();
  });

  it("referenced static files exist", () => {
    for (const file of ["popup.html", "options.html", "ui.css", ...Object.values<string>(manifest.icons)]) {
      expect(existsSync(join(staticDir, file)), file).toBe(true);
    }
    const png = readFileSync(join(staticDir, "icons/icon-128.png"));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(128);
  });

  it("pages load their bundles", () => {
    expect(readFileSync(join(staticDir, "popup.html"), "utf8")).toContain('src="popup.js"');
    expect(readFileSync(join(staticDir, "options.html"), "utf8")).toContain('src="options.js"');
  });
});
