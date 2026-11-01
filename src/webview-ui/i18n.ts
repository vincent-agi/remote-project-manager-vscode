/**
 * Message translation for the webview. As in the extension host, the
 * English text is the key: `t("Save")` returns the French string when the
 * page language is French and the English text otherwise, substituting
 * `{0}`, `{1}`, ... with the arguments. Pure modules take a `Translate` so
 * they stay free of any global state and testable in English.
 */
import { FRENCH } from "./translations.js";

export type Translate = (message: string, ...args: (string | number)[]) => string;

export function formatMessage(message: string, args: readonly (string | number)[]): string {
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? placeholder : String(value);
  });
}

/** The untranslated implementation, used as the default by pure modules. */
export const identityTranslate: Translate = (message, ...args) => formatMessage(message, args);

let table: Readonly<Record<string, string>> = {};

/** Selects the translation table for a BCP 47 language tag; unknown languages fall back to English. */
export function setLanguage(language: string): void {
  table = language.toLowerCase().startsWith("fr") ? FRENCH : {};
}

/** Translates `message` into the current language. */
export const t: Translate = (message, ...args) => formatMessage(table[message] ?? message, args);
