import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/webview-ui/markdown";

describe("renderMarkdown formatting", () => {
  it("renders headings, paragraphs and line breaks", () => {
    expect(renderMarkdown("# Title\n\nline one\nline two")).toBe(
      "<h1>Title</h1>\n<p>line one<br>line two</p>",
    );
  });

  it("renders bold, italic and inline code", () => {
    expect(renderMarkdown("**b** *i* _j_ `c`")).toBe(
      "<p><strong>b</strong> <em>i</em> <em>j</em> <code>c</code></p>",
    );
  });

  it("does not format inside inline code", () => {
    expect(renderMarkdown("`**not bold**`")).toBe("<p><code>**not bold**</code></p>");
  });

  it("renders fenced code blocks verbatim and escaped", () => {
    expect(renderMarkdown("```ts\nconst a = '<b>';\n```")).toBe(
      "<pre><code>const a = &#39;&lt;b&gt;&#39;;</code></pre>",
    );
  });

  it("keeps an unterminated fence as code up to the end", () => {
    expect(renderMarkdown("```\nx")).toBe("<pre><code>x</code></pre>");
  });

  it("renders bullet, numbered and task lists", () => {
    expect(renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
    expect(renderMarkdown("- [x] done\n- [ ] todo")).toBe(
      '<ul><li class="task"><input type="checkbox" disabled checked> done</li><li class="task"><input type="checkbox" disabled> todo</li></ul>',
    );
  });

  it("renders blockquotes and rules", () => {
    expect(renderMarkdown("> quoted")).toBe("<blockquote><p>quoted</p></blockquote>");
    expect(renderMarkdown("---")).toBe("<hr>");
  });

  it("renders http(s) links that open safely", () => {
    expect(renderMarkdown("[x](https://example.com/a?b=1&c=2)")).toBe(
      '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">x</a></p>',
    );
  });
});

describe("renderMarkdown safety", () => {
  it("escapes raw HTML", () => {
    const html = renderMarkdown('<script>alert(1)</script><img src=x onerror="alert(1)">');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not link non-http schemes", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "vbscript:x",
      "file:///etc/passwd",
    ]) {
      const html = renderMarkdown(`[click](${url})`);
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("href");
    }
  });

  it("cannot break out of the href attribute", () => {
    const html = renderMarkdown('[x](https://e.com/"onmouseover="alert(1))');
    expect(html).not.toMatch(/onmouseover="/);
  });

  it("does not render images", () => {
    expect(renderMarkdown("![alt](https://e.com/p.png)")).not.toContain("<img");
  });

  it("neutralizes NUL placeholders in the source", () => {
    const html = renderMarkdown("`a` \u00000\u0000");
    expect(html).toBe("<p><code>a</code> 0</p>");
  });

  it("escapes HTML inside link labels, headings and list items", () => {
    expect(renderMarkdown("[<b>x</b>](https://e.com)")).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(renderMarkdown("# <i>h</i>")).toContain("&lt;i&gt;");
    expect(renderMarkdown("- <u>l</u>")).toContain("&lt;u&gt;");
  });
});
