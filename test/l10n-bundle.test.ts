import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Every `vscode.l10n.t("…")` / core `t("…")` literal in the host sources (the webview has its own table). */
function collectSourceKeys(dir: string, keys = new Set<string>()): Set<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "webview-ui") {
        collectSourceKeys(path, keys);
      }
    } else if (path.endsWith(".ts")) {
      const source = readFileSync(path, "utf8");
      const pattern =
        /(?:\bvscode\.l10n\.t|(?<![\w.])t)\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gs;
      for (const match of source.matchAll(pattern)) {
        const literal = match[1];
        keys.add(
          literal.startsWith('"')
            ? (JSON.parse(literal) as string)
            : literal.slice(1, -1).replace(/\\'/g, "'"),
        );
      }
    }
  }
  return keys;
}

const french = JSON.parse(readFileSync("l10n/bundle.l10n.fr.json", "utf8")) as Record<
  string,
  string
>;
const sourceKeys = collectSourceKeys("src");

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();

describe("l10n bundle", () => {
  it("finds the translatable messages", () => {
    expect(sourceKeys.size).toBeGreaterThan(50);
  });

  it("translates every message used in the sources", () => {
    expect([...sourceKeys].filter((key) => !(key in french))).toEqual([]);
  });

  it("has no stale French entries", () => {
    expect(Object.keys(french).filter((key) => !sourceKeys.has(key))).toEqual([]);
  });

  it("keeps the same placeholders in every translation", () => {
    for (const [english, translated] of Object.entries(french)) {
      expect(placeholders(translated), english).toEqual(placeholders(english));
    }
  });
});

describe("webview translations", () => {
  const webviewKeys = new Set<string>();
  const pattern = /(?<![\w.])t\(\s*("(?:[^"\\]|\\.)*")/gs;
  for (const file of readdirSync("src/webview-ui")) {
    if (file.endsWith(".ts") && file !== "i18n.ts" && file !== "translations.ts") {
      const source = readFileSync(join("src/webview-ui", file), "utf8");
      for (const match of source.matchAll(pattern)) {
        webviewKeys.add(JSON.parse(match[1]) as string);
      }
    }
  }
  // Messages the host sends at runtime (toasts and errors) and the webview translates on display.
  const hostMessages = [
    ...readFileSync("src/webview/panel-controller.ts", "utf8").matchAll(
      /(?:actionSuccess|error)",\s*message:\s*("(?:[^"\\]|\\.)*")/gs,
    ),
  ].map((match) => JSON.parse(match[1]) as string);

  it("finds the webview messages", () => {
    expect(webviewKeys.size).toBeGreaterThan(50);
    expect(hostMessages.length).toBeGreaterThan(3);
  });

  it("translates every message the webview displays", async () => {
    const { FRENCH } = await import("../src/webview-ui/translations");
    expect([...webviewKeys, ...hostMessages].filter((key) => !(key in FRENCH))).toEqual([]);
  });

  it("has no stale webview translations", async () => {
    const { FRENCH } = await import("../src/webview-ui/translations");
    const used = new Set([...webviewKeys, ...hostMessages]);
    expect(Object.keys(FRENCH).filter((key) => !used.has(key))).toEqual([]);
  });

  it("keeps the same placeholders in every translation", async () => {
    const { FRENCH } = await import("../src/webview-ui/translations");
    for (const [english, translated] of Object.entries(FRENCH)) {
      expect(placeholders(translated), english).toEqual(placeholders(english));
    }
  });
});
