import { describe, expect, it } from "vitest";
import { parseIssueTemplate } from "../../../src/core/templates/issue-template";

describe("parseIssueTemplate", () => {
  it("reads front matter and the body", () => {
    const template = parseIssueTemplate(
      "bug_report.md",
      `---\nname: Bug report\nabout: Report a bug\ntitle: "[BUG] "\nlabels: bug, help wanted\nassignees: ''\n---\n\n**Describe the bug**\n\nSteps...\n`,
    );
    expect(template).toEqual({
      name: "Bug report",
      title: "[BUG] ",
      labels: ["bug", "help wanted"],
      body: "**Describe the bug**\n\nSteps...",
    });
  });

  it("accepts a bracketed label list and quoted labels", () => {
    const template = parseIssueTemplate("x.md", `---\nlabels: ['a b', "c"]\n---\nbody`);
    expect(template?.labels).toEqual(["a b", "c"]);
  });

  it("handles a template with no front matter, naming it after the file", () => {
    expect(parseIssueTemplate("feature-request.md", "Just a body\n")).toEqual({
      name: "Feature request",
      body: "Just a body",
      labels: [],
    });
  });

  it("handles CRLF line endings", () => {
    expect(parseIssueTemplate("a.md", "---\r\nname: A\r\n---\r\nbody\r\n")).toMatchObject({
      name: "A",
      body: "body",
    });
  });

  it("skips issue forms and other non-Markdown files", () => {
    expect(parseIssueTemplate("bug.yml", "name: x")).toBeNull();
    expect(parseIssueTemplate("config.yaml", "x")).toBeNull();
  });
});
