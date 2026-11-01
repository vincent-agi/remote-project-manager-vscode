/** WCAG AA contrast ratio required for normal-size text. */
export const MIN_CONTRAST = 4.5;

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Parses `rrggbb`, `#rrggbb`, `rgb` or `#rgb`; `null` for anything else. */
export function parseHexColor(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, "");
  const full = /^[0-9a-fA-F]{3}$/.test(hex) ? [...hex].map((digit) => digit + digit).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    return null;
  }
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }: Rgb): string {
  const part = (channel: number): string =>
    Math.round(Math.min(255, Math.max(0, channel)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

function linear(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance per WCAG 2.x. */
export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Contrast ratio between two colours, from 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** Colours for a badge: the label's own colour, adjusted only as much as needed to stay readable. */
export interface BadgeColors {
  readonly background: string;
  readonly foreground: string;
}

/**
 * Text and background for a label badge. The text is black or white,
 * whichever contrasts more with the label colour; when even that falls
 * short of {@link MIN_CONTRAST} (mid-tone colours), the background is
 * pushed away from the text colour in small steps until it passes, so the
 * badge still reads as the label's colour. Returns `null` for an
 * unparsable colour so callers can keep the theme's default badge.
 */
export function readableBadgeColors(labelColor: string): BadgeColors | null {
  const background = parseHexColor(labelColor);
  if (!background) {
    return null;
  }
  const textIsWhite = contrastRatio(background, WHITE) >= contrastRatio(background, BLACK);
  const text = textIsWhite ? WHITE : BLACK;
  // Move the background away from the text: darker under white text, lighter under black.
  const target = textIsWhite ? BLACK : WHITE;
  let adjusted = background;
  for (let step = 1; step <= 20 && contrastRatio(adjusted, text) < MIN_CONTRAST; step += 1) {
    const mix = step * 0.05;
    adjusted = {
      r: background.r + (target.r - background.r) * mix,
      g: background.g + (target.g - background.g) * mix,
      b: background.b + (target.b - background.b) * mix,
    };
  }
  return { background: toHex(adjusted), foreground: toHex(text) };
}
