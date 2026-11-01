/** One `TODO` / `FIXME` marker found in a document. */
export interface TodoMarker {
  readonly line: number;
  readonly keyword: "TODO" | "FIXME";
  /** Column right after the keyword (where ` #N` would be inserted). */
  readonly keywordEnd: number;
  /** Issue number referenced right after the keyword, if any. */
  readonly issueNumber: number | null;
  /** Start/end columns of the `#N` reference, when present. */
  readonly referenceStart?: number;
  readonly referenceEnd?: number;
  /** The text after the marker, trimmed — the natural issue title. */
  readonly text: string;
}

/** Only markers that sit inside a line comment are considered. */
const MARKER =
  /(?:\/\/|#|--|\/\*+|\*|<!--|;)\s*(TODO|FIXME)\b(?:[\s:]*\(?\s*#(\d+)\s*\)?)?[\s:.-]*(.*)$/;

/**
 * Finds `TODO` / `FIXME` markers in comment lines. A marker may reference
 * an issue as `TODO #12`, `TODO(#12)` or `FIXME: #12 ...`. Pure: takes the
 * document's lines, returns zero-based positions.
 */
export function scanTodos(lines: readonly string[]): TodoMarker[] {
  const markers: TodoMarker[] = [];
  lines.forEach((text, line) => {
    const match = MARKER.exec(text);
    if (!match) {
      return;
    }
    const keyword = match[1] as "TODO" | "FIXME";
    const keywordStart = text.indexOf(keyword, match.index);
    const keywordEnd = keywordStart + keyword.length;
    const issueNumber = match[2] === undefined ? null : Number(match[2]);
    const referenceStart =
      issueNumber === null ? undefined : text.indexOf(`#${match[2]}`, keywordEnd);
    markers.push({
      line,
      keyword,
      keywordEnd,
      issueNumber,
      ...(referenceStart === undefined
        ? {}
        : { referenceStart, referenceEnd: referenceStart + `#${match[2]}`.length }),
      text: (match[3] ?? "").replace(/\s*(\*\/|-->)\s*$/, "").trim(),
    });
  });
  return markers;
}
