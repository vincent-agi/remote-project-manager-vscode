/** An issue template offered in the new-issue form. */
export interface IssueTemplate {
  readonly name: string;
  readonly body: string;
  /** Default title prefix, from the template's front matter. */
  readonly title?: string;
  readonly labels: readonly string[];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  return (quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length >= 2
    ? trimmed.slice(1, -1)
    : trimmed;
}

function humanize(fileName: string): string {
  const base = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : "Template";
}

/**
 * Parses a Markdown issue template (`.github/ISSUE_TEMPLATE/*.md`,
 * `.gitlab/issue_templates/*.md`): optional YAML front matter with `name`,
 * `title` and `labels` (comma-separated or a `[a, b]` list), then the body.
 * Returns `null` for non-Markdown files — GitHub issue *forms* (`.yml`)
 * are structured schemas that a plain text area cannot represent.
 */
export function parseIssueTemplate(fileName: string, content: string): IssueTemplate | null {
  if (!/\.(md|markdown)$/i.test(fileName)) {
    return null;
  }
  const normalized = content.replace(/\r\n?/g, "\n");
  const frontMatter = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  const fields = new Map<string, string>();
  if (frontMatter) {
    for (const line of frontMatter[1].split("\n")) {
      const pair = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (pair) {
        fields.set(pair[1].toLowerCase(), unquote(pair[2]));
      }
    }
  }
  const body = (frontMatter ? normalized.slice(frontMatter[0].length) : normalized).trim();
  const labels = (fields.get("labels") ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((label) => unquote(label))
    .filter((label) => label !== "");
  const title = fields.get("title");
  return {
    name: fields.get("name") || humanize(fileName),
    body,
    ...(title ? { title } : {}),
    labels,
  };
}
