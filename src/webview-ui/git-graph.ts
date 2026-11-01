// Script of the Git Graph panel (`<script type="module">`). Message shapes
// are mirrored by hand from src/git-graph-panel.ts (separate rootDir).

import { layoutGraph } from "./graph-layout.js";
import { renderGraphRowSvg } from "./graph-svg.js";

interface GraphCommitView {
  hash: string;
  parents: string[];
  author: string;
  date: string;
  refs: string[];
  subject: string;
  issueNumber: number | null;
}

type OutboundMessage =
  | {
      type: "graph";
      commits: GraphCommitView[];
      issues: { number: number; title: string }[];
      head: string | null;
    }
  | { type: "error"; message: string };

type InboundMessage =
  | { type: "requestGraph" }
  | { type: "openDiff"; hash: string }
  | { type: "copyHash"; hash: string };

declare function acquireVsCodeApi(): { postMessage(message: InboundMessage): void };
const vscodeApi = acquireVsCodeApi();

const NO_ISSUE_FILTER = "";
const UNLINKED_FILTER = "unlinked";

let commits: GraphCommitView[] = [];
let issueTitles = new Map<number, string>();
let head: string | null = null;
let issueFilter = NO_ISSUE_FILTER;
let textFilter = "";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing element #${id}`);
  }
  return el as T;
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function visibleCommits(): GraphCommitView[] {
  const query = textFilter.trim().toLowerCase();
  return commits.filter((commit) => {
    if (issueFilter === UNLINKED_FILTER && commit.issueNumber !== null) {
      return false;
    }
    if (
      issueFilter !== NO_ISSUE_FILTER &&
      issueFilter !== UNLINKED_FILTER &&
      commit.issueNumber !== Number(issueFilter)
    ) {
      return false;
    }
    return (
      !query ||
      commit.subject.toLowerCase().includes(query) ||
      commit.author.toLowerCase().includes(query) ||
      commit.hash.startsWith(query)
    );
  });
}

function renderFilterOptions(): void {
  const select = byId<HTMLSelectElement>("issue-filter");
  const numbers = [
    ...new Set(
      commits.flatMap((commit) => (commit.issueNumber === null ? [] : [commit.issueNumber])),
    ),
  ].sort((a, b) => b - a);
  select.innerHTML =
    `<option value="${NO_ISSUE_FILTER}">All commits</option>` +
    `<option value="${UNLINKED_FILTER}">Not linked to an issue</option>` +
    numbers
      .map((number) => {
        const title = issueTitles.get(number);
        return `<option value="${number}">#${number}${title ? ` ${escapeHtml(title)}` : ""}</option>`;
      })
      .join("");
  select.value = issueFilter;
}

function render(): void {
  const list = byId<HTMLDivElement>("graph");
  const shown = visibleCommits();
  byId<HTMLParagraphElement>("graph-note").textContent =
    `${shown.length} of ${commits.length} commits (all branches). Click a commit to see its changes.`;
  if (shown.length === 0) {
    list.innerHTML = `<p class="empty-state">No commits match.</p>`;
    return;
  }
  // The layout is recomputed on the filtered list: parents that were
  // filtered out simply end their lines.
  const layout = layoutGraph(shown);
  const byHash = new Map(shown.map((commit) => [commit.hash, commit]));
  list.innerHTML = "";
  for (const row of layout.rows) {
    const commit = byHash.get(row.hash);
    if (!commit) {
      continue;
    }
    const item = document.createElement("div");
    item.className = "graph-row";
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.setAttribute("aria-label", `${commit.hash.slice(0, 7)} ${commit.subject}`);
    const refs = commit.refs
      .map(
        (ref) => `<span class="badge ref${ref === head ? " head" : ""}">${escapeHtml(ref)}</span>`,
      )
      .join("");
    const issue =
      commit.issueNumber === null ? "" : `<span class="badge">#${commit.issueNumber}</span>`;
    item.innerHTML = `${renderGraphRowSvg(row, layout.laneCount)}<span class="graph-text"><span class="graph-subject">${escapeHtml(commit.subject)}</span>${refs}${issue}</span><span class="graph-meta">${escapeHtml(commit.author)} · ${escapeHtml(new Date(commit.date).toLocaleDateString())} · <code>${escapeHtml(commit.hash.slice(0, 7))}</code></span>`;
    const open = (): void => vscodeApi.postMessage({ type: "openDiff", hash: commit.hash });
    item.addEventListener("click", open);
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      vscodeApi.postMessage({ type: "copyHash", hash: commit.hash });
    });
    list.appendChild(item);
  }
}

byId<HTMLSelectElement>("issue-filter").addEventListener("change", (event) => {
  issueFilter = (event.target as HTMLSelectElement).value;
  render();
});
byId<HTMLInputElement>("text-filter").addEventListener("input", (event) => {
  textFilter = (event.target as HTMLInputElement).value;
  render();
});
byId<HTMLButtonElement>("refresh").addEventListener("click", () => {
  vscodeApi.postMessage({ type: "requestGraph" });
});

window.addEventListener("message", (event: MessageEvent<OutboundMessage>) => {
  const message = event.data;
  if (message.type === "graph") {
    commits = message.commits;
    issueTitles = new Map(message.issues.map((issue) => [issue.number, issue.title]));
    head = message.head;
    renderFilterOptions();
    render();
  } else {
    byId<HTMLParagraphElement>("graph-note").textContent = message.message;
  }
});

vscodeApi.postMessage({ type: "requestGraph" });
