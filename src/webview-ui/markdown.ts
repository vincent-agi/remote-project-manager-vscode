/**
 * A small, dependency-free Markdown renderer for the issue editor preview.
 *
 * Safety model: every piece of source text is HTML-escaped before any
 * markup is added, and the only markup ever emitted comes from this file.
 * Raw HTML in the source is therefore shown as text, links are limited to
 * `http:`/`https:`, and images are not supported (they would let an issue
 * body ping arbitrary hosts from the webview).
 *
 * Supported: headings, paragraphs (single newline = line break), fenced
 * code, inline code, bold, italic, links, blockquotes, bullet/numbered
 * lists, task lists, horizontal rules.
 */

export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** `url` if it is an absolute http(s) URL, otherwise `null`. */
function safeUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(decodeEntities(rawUrl));
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

const NUL = "\u0000";

/** Inline formatting over text that is already HTML-escaped. */
function renderInline(escaped: string): string {
  const stash: string[] = [];
  const hold = (html: string): string => {
    stash.push(html);
    return `${NUL}${stash.length - 1}${NUL}`;
  };

  let text = escaped.replace(/`([^`\n]+)`/g, (_match, code: string) =>
    hold(`<code>${code}</code>`),
  );
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
    const href = safeUrl(url);
    return href === null
      ? match
      : hold(
          `<a href="${escapeHtmlText(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`,
        );
  });
  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");

  return text.replace(
    new RegExp(`${NUL}(\\d+)${NUL}`, "g"),
    (_match, index: string) => stash[Number(index)] ?? "",
  );
}

/** Renders `source` to safe HTML. See the module comment for what is supported. */
export function renderMarkdown(source: string): string {
  const lines = source.split(NUL).join("").replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      html.push(
        `<p>${paragraph.map((line) => renderInline(escapeHtmlText(line))).join("<br>")}</p>`,
      );
      paragraph = [];
    }
  };

  while (index < lines.length) {
    const line = lines[index];

    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence (or EOF)
      html.push(`<pre><code>${escapeHtmlText(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(escapeHtmlText(heading[2]))}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      html.push("<hr>");
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      html.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
      continue;
    }

    const listMatch = /^(\s*)([-*+]|\d+\.)\s+/.exec(line);
    if (listMatch) {
      flushParagraph();
      const ordered = /\d/.test(listMatch[2]);
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[index]);
        if (!item || /\d/.test(item[2]) !== ordered) {
          break;
        }
        const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
        items.push(
          task
            ? `<li class="task"><input type="checkbox" disabled${
                task[1] === " " ? "" : " checked"
              }> ${renderInline(escapeHtmlText(task[2]))}</li>`
            : `<li>${renderInline(escapeHtmlText(item[3]))}</li>`,
        );
        index += 1;
      }
      html.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }

    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return html.join("\n");
}
