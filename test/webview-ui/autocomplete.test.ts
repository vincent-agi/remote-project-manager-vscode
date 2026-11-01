import { describe, expect, it } from "vitest";
import {
  applySuggestion,
  findTrigger,
  suggest,
  type SuggestionSources,
} from "../../src/webview-ui/autocomplete";

const sources: SuggestionSources = {
  issues: [
    { number: 12, title: "Login fails" },
    { number: 120, title: "Dark mode" },
    { number: 7, title: "Fix login redirect" },
  ],
  users: ["alice", "bob", "malice"],
  labels: ["bug", "good first issue", "ui"],
};

describe("findTrigger", () => {
  it("finds a trigger at the start or after whitespace", () => {
    expect(findTrigger("#1", 2)).toEqual({ trigger: "#", start: 0, query: "1" });
    expect(findTrigger("see @al", 7)).toEqual({ trigger: "@", start: 4, query: "al" });
    expect(findTrigger("x ~", 3)).toEqual({ trigger: "~", start: 2, query: "" });
  });

  it("ignores triggers glued to a word (emails, URL fragments)", () => {
    expect(findTrigger("me@example.com", 14)).toBeNull();
    expect(findTrigger("http://x/#frag", 14)).toBeNull();
  });

  it("ignores a token the caret has already left", () => {
    expect(findTrigger("#12 and more", 12)).toBeNull();
  });

  it("only looks before the caret", () => {
    expect(findTrigger("#12 #34", 3)).toEqual({ trigger: "#", start: 0, query: "12" });
  });
});

describe("suggest", () => {
  it("suggests issues by number or title, prefix matches first", () => {
    const result = suggest({ trigger: "#", start: 0, query: "12" }, sources);
    expect(result.map((s) => s.insertText)).toEqual(["#12", "#120"]);
    const byTitle = suggest({ trigger: "#", start: 0, query: "login" }, sources);
    expect(byTitle.map((s) => s.insertText)).toEqual(["#12", "#7"]);
  });

  it("suggests users, prefix before substring", () => {
    const result = suggest({ trigger: "@", start: 0, query: "al" }, sources);
    expect(result.map((s) => s.insertText)).toEqual(["@alice", "@malice"]);
  });

  it("quotes labels containing spaces", () => {
    const result = suggest({ trigger: "~", start: 0, query: "good" }, sources);
    expect(result).toEqual([{ label: "~good first issue", insertText: '~"good first issue"' }]);
  });

  it("lists everything (capped) for an empty query", () => {
    expect(suggest({ trigger: "@", start: 0, query: "" }, sources)).toHaveLength(3);
    const many = { ...sources, users: Array.from({ length: 20 }, (_, i) => `u${i}`) };
    expect(suggest({ trigger: "@", start: 0, query: "" }, many)).toHaveLength(8);
  });

  it("returns nothing when nothing matches", () => {
    expect(suggest({ trigger: "#", start: 0, query: "zzz" }, sources)).toEqual([]);
  });
});

describe("applySuggestion", () => {
  it("replaces the token and moves the caret after the inserted text", () => {
    const text = "see @al please";
    const match = findTrigger(text, 7)!;
    const result = applySuggestion(text, 7, match, { label: "@alice", insertText: "@alice" });
    expect(result.text).toBe("see @alice  please");
    expect(result.caret).toBe("see @alice ".length);
  });
});
