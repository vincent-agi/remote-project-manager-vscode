import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

const manifest = readFileSync("package.json", "utf8");
const english = read("package.nls.json") as Record<string, string>;
const french = read("package.nls.fr.json") as Record<string, string>;

describe("manifest localization", () => {
  it("defines every %key% the manifest references", () => {
    const referenced = [...manifest.matchAll(/"%([\w.]+)%"/g)].map((match) => match[1]);
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((key) => !(key in english))).toEqual([]);
  });

  it("has no unused English entries", () => {
    const referenced = new Set([...manifest.matchAll(/"%([\w.]+)%"/g)].map((match) => match[1]));
    expect(Object.keys(english).filter((key) => !referenced.has(key))).toEqual([]);
  });

  it("translates exactly the same keys into French", () => {
    expect(Object.keys(french).sort()).toEqual(Object.keys(english).sort());
  });

  it("keeps command links and placeholders intact in French", () => {
    const links = (text: string): string[] =>
      [...text.matchAll(/\(command:[^)]+\)/g)].map((m) => m[0]);
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\$\{\w+\}/g)].map((m) => m[0]);
    for (const [key, value] of Object.entries(english)) {
      expect(links(french[key]), key).toEqual(links(value));
      expect(placeholders(french[key]), key).toEqual(placeholders(value));
    }
  });
});
