/**
 * Translates a message, substituting `{0}`, `{1}`, ... with `args`. This is
 * the shape of `vscode.l10n.t`, so core modules (which must not import
 * `vscode`) take a `Translate` and the extension host passes the real one.
 */
export type Translate = (message: string, ...args: (string | number)[]) => string;

/** Replaces `{n}` placeholders in `message`, leaving unknown indexes untouched. */
export function formatMessage(message: string, args: readonly (string | number)[]): string {
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? placeholder : String(value);
  });
}

/** The untranslated (English) implementation: just formats the placeholders. */
export const identityTranslate: Translate = (message, ...args) => formatMessage(message, args);
