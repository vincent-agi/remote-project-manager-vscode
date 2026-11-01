import { describe, expect, it } from "vitest";
import {
  findSettingDescriptor,
  SETTING_DESCRIPTORS,
  validateSettingValue,
} from "../../../src/core/settings/settings-schema";
import { readFileSync } from "node:fs";

const descriptor = (key: string) => findSettingDescriptor(key)!;

describe("validateSettingValue", () => {
  it("accepts and rejects booleans", () => {
    expect(validateSettingValue(descriptor("todoCodeLens"), false)).toEqual({
      ok: true,
      value: false,
    });
    expect(validateSettingValue(descriptor("todoCodeLens"), "yes").ok).toBe(false);
  });

  it("enforces the minimum of numbers and rejects NaN/strings", () => {
    expect(validateSettingValue(descriptor("cacheTtlSeconds"), 0).ok).toBe(true);
    expect(validateSettingValue(descriptor("cacheTtlSeconds"), -1).ok).toBe(false);
    expect(validateSettingValue(descriptor("cacheTtlSeconds"), Number.NaN).ok).toBe(false);
    expect(validateSettingValue(descriptor("cacheTtlSeconds"), "60").ok).toBe(false);
  });

  it("trims strings and rejects non-strings", () => {
    expect(validateSettingValue(descriptor("repository"), "  o/r ")).toEqual({
      ok: true,
      value: "o/r",
    });
    expect(validateSettingValue(descriptor("repository"), 3).ok).toBe(false);
  });

  it("cleans lists of text and rejects anything else", () => {
    expect(
      validateSettingValue(descriptor("aiContextFiles"), [" CLAUDE.md ", "", "AGENTS.md"]),
    ).toEqual({
      ok: true,
      value: ["CLAUDE.md", "AGENTS.md"],
    });
    expect(validateSettingValue(descriptor("aiContextFiles"), "CLAUDE.md").ok).toBe(false);
    expect(validateSettingValue(descriptor("aiContextFiles"), ["a", 1]).ok).toBe(false);
  });

  it("only accepts listed enum values", () => {
    expect(validateSettingValue(descriptor("provider"), "gitlab").ok).toBe(true);
    expect(validateSettingValue(descriptor("provider"), "bitbucket")).toEqual({
      ok: false,
      reason: "Expected one of: github, gitlab, gitea.",
    });
  });
});

describe("SETTING_DESCRIPTORS", () => {
  const properties = (
    JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes: { configuration: { properties: Record<string, { type: string }> } };
    }
  ).contributes.configuration.properties;

  it("only lists settings the manifest contributes", () => {
    for (const { key } of SETTING_DESCRIPTORS) {
      expect(properties, key).toHaveProperty(`remoteProjectManager.${key}`);
    }
  });

  it("covers every contributed setting, so none is missing from the page", () => {
    const listed = new Set(SETTING_DESCRIPTORS.map(({ key }) => `remoteProjectManager.${key}`));
    expect(Object.keys(properties).filter((key) => !listed.has(key))).toEqual([]);
  });

  it("matches the manifest's types", () => {
    for (const { key, kind } of SETTING_DESCRIPTORS) {
      const manifestType = properties[`remoteProjectManager.${key}`].type;
      const accepted: Record<string, string[]> = {
        string: ["string", "enum"],
        array: ["list"],
      };
      expect(accepted[manifestType] ?? [manifestType], key).toContain(kind.type);
    }
  });
});

describe("buildSettingEntries", () => {
  it("builds an entry per descriptor with labels, scope and default detection", async () => {
    const { buildSettingEntries } = await import("../../../src/core/settings/settings-schema");
    const entries = buildSettingEntries((key) =>
      key === "cacheTtlSeconds"
        ? { value: 60, defaultValue: 180 }
        : { value: "same", defaultValue: "same" },
    );
    expect(entries).toHaveLength(SETTING_DESCRIPTORS.length);
    const cache = entries.find((entry) => entry.key === "cacheTtlSeconds")!;
    expect(cache).toMatchObject({
      group: "connection",
      groupLabel: "Connection",
      label: "Cache duration (seconds)",
      scope: "user",
      value: 60,
      defaultValue: 180,
      isDefault: false,
    });
    expect(entries.find((entry) => entry.key === "repository")!.isDefault).toBe(true);
    expect(entries.every((entry) => entry.label !== entry.key)).toBe(true);
  });
});
