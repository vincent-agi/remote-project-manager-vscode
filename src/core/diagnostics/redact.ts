/**
 * Token shapes that must never reach a log or a copied report: GitHub
 * (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`) and GitLab
 * (`glpat-`) personal/OAuth tokens, plus `Authorization`-style headers.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\b(authorization\s*[:=]\s*)(?:bearer|token|basic)?\s*\S+/gi,
];

/** Replaces anything that looks like an access token with `[redacted]`. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (result, pattern) =>
      result.replace(pattern, (...args: unknown[]) => {
        const prefix = typeof args[1] === "string" ? args[1] : "";
        return `${prefix}[redacted]`;
      }),
    text,
  );
}
