import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  MIN_CONTRAST,
  parseHexColor,
  readableBadgeColors,
} from "../../src/webview-ui/contrast";

describe("parseHexColor", () => {
  it("accepts 6- and 3-digit hex with or without #", () => {
    expect(parseHexColor("d73a4a")).toEqual({ r: 215, g: 58, b: 74 });
    expect(parseHexColor("#FFF")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("rejects anything else", () => {
    for (const value of ["", "xyz", "#12345", "rgb(1,2,3)", "#ggghhh"]) {
      expect(parseHexColor(value)).toBeNull();
    }
  });
});

describe("contrastRatio", () => {
  it("is 21 for black on white and 1 for identical colours", () => {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
  });
});

describe("readableBadgeColors", () => {
  const ratio = (colors: { background: string; foreground: string }): number =>
    contrastRatio(parseHexColor(colors.background)!, parseHexColor(colors.foreground)!);

  it("uses white text on dark labels and black text on light labels", () => {
    expect(readableBadgeColors("0b2e6b")?.foreground).toBe("#ffffff");
    expect(readableBadgeColors("fbca04")?.foreground).toBe("#000000");
  });

  it("keeps the label colour unchanged when it already passes", () => {
    expect(readableBadgeColors("000000")).toEqual({ background: "#000000", foreground: "#ffffff" });
  });

  it("always reaches AA contrast, even for mid-tone colours", () => {
    for (const color of [
      "808080",
      "777777",
      "ff0000",
      "00ff00",
      "0000ff",
      "ff8800",
      "7f7fff",
      "d73a4a",
      "a2eeef",
    ]) {
      const colors = readableBadgeColors(color)!;
      expect(ratio(colors)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });

  it("returns null for an unparsable colour", () => {
    expect(readableBadgeColors("not-a-colour")).toBeNull();
  });
});
