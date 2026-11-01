// This file compiles to an ES module loaded with `<script type="module">`.
// Pure logic lives in sibling modules (imported with a `.js` extension, as
// the browser sees the compiled output) so it can be unit tested. The
// message shapes below are mirrored by hand from src/webview/messages.ts,
// because the host and webview programs have separate `rootDir`s.

import { hasStateChanged } from "./state-diff.js";
import { BOARD_COLUMNS, buildBoard, planBoardMove, type BoardColumnId } from "./board-model.js";
import { describeCacheAge } from "./cache-age.js";
import { moveSelection, shortcutFor, SHORTCUT_HELP } from "./keyboard-shortcuts.js";
import {
  computeMilestoneProgress,
  describeDue,
  type MilestoneProgress,
} from "./milestone-progress.js";
import {
  EMPTY_FILTER,
  filterIssues,
  NO_MILESTONE,
  PRESET_FILTERS,
  readSavedFilters,
  removeSavedFilter,
  sameFilter,
  upsertSavedFilter,
  groupIssues,
  ISSUE_GROUPS,
  ISSUE_SORTS,
  readListPrefs,
  sortIssues,
  type IssueFilter,
  type IssueGroup,
  type IssueSort,
  type SavedFilter,
} from "./issue-view-model.js";

interface RepositoryOptionView {
  id: string;
  label: string;
  provider: "github" | "gitlab";
  repository: string;
}

interface IssueView {
  id: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: readonly string[];
  assignees: readonly string[];
  milestoneId: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  commentsCount: number;
}

interface MilestoneView {
  id: string;
  number: number;
  title: string;
  description: string;
  state: "open" | "closed";
  dueOn: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
}

interface Capabilities {
  canReadIssues: boolean;
  canWriteIssues: boolean;
  canReadMilestones: boolean;
  canWriteMilestones: boolean;
}

interface AuthenticatedUser {
  username: string;
}

interface StateSnapshot {
  issues: IssueView[];
  milestones: MilestoneView[];
  capabilities: Capabilities;
  currentUser: AuthenticatedUser;
  availableLabels: string[];
  availableAssignableUsers: string[];
}

type OutboundMessage =
  | {
      type: "state";
      issues: IssueView[];
      milestones: MilestoneView[];
      capabilities: Capabilities;
      currentUser: AuthenticatedUser;
      availableLabels: string[];
      availableAssignableUsers: string[];
      dataFetchedAt?: number;
    }
  | { type: "uiPrefs"; prefs: Record<string, unknown> }
  | { type: "repositoryOptions"; options: RepositoryOptionView[] }
  | { type: "selectIssue"; id: string }
  | { type: "openNewIssueForm" }
  | { type: "openNewMilestoneForm" }
  | { type: "actionSuccess"; message: string }
  | { type: "error"; message: string; authError?: boolean };

type InboundMessage =
  | { type: "requestState"; forceRefresh?: boolean }
  | { type: "selectRepository"; id: string }
  | {
      type: "createIssue";
      input: { title: string; body: string; milestoneId?: string | null };
    }
  | {
      type: "updateIssue";
      id: string;
      patch: Partial<
        Pick<IssueView, "title" | "body" | "state" | "assignees" | "labels" | "milestoneId">
      >;
    }
  | {
      type: "createMilestone";
      input: { title: string; description?: string; dueOn?: string | null };
    }
  | {
      type: "updateMilestone";
      id: string;
      patch: Partial<Pick<MilestoneView, "title" | "description" | "state" | "dueOn">>;
    }
  | { type: "createBranchForIssue"; id: string }
  | { type: "saveUiPrefs"; prefs: Record<string, unknown> }
  | { type: "reconnect" };

declare function acquireVsCodeApi(): {
  postMessage(message: InboundMessage): void;
};

const vscodeApi = acquireVsCodeApi();

let currentIssues: IssueView[] = [];
let currentMilestones: MilestoneView[] = [];
let currentCapabilities: Capabilities = {
  canReadIssues: false,
  canWriteIssues: false,
  canReadMilestones: false,
  canWriteMilestones: false,
};
let currentUser: AuthenticatedUser | null = null;
let currentAvailableLabels: string[] = [];
let currentAvailableAssignableUsers: string[] = [];
let selectedIssueId: string | null = null;
let selectedMilestoneId: string | null = null;
let issueFilter: IssueFilter = EMPTY_FILTER;
let uiPrefs: Record<string, unknown> = {};
let savedFilters: SavedFilter[] = [];
let visibleIssueIds: string[] = [];
let issueSort: IssueSort = "default";
let issueGroup: IssueGroup = "none";
let milestoneStateFilter: "all" | "open" | "closed" = "all";
const LIST_PAGE_SIZE = 50;
let issueListPageSize = LIST_PAGE_SIZE;
let milestoneListPageSize = LIST_PAGE_SIZE;
let showNewIssueForm = false;
let showNewMilestoneForm = false;
let lastState: StateSnapshot | null = null;

function post(message: InboundMessage): void {
  vscodeApi.postMessage(message);
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing element #${id}`);
  }
  return el as T;
}

let errorTimer: number | undefined;

function showError(message: string, authError = false): void {
  const banner = byId<HTMLDivElement>("error-banner");
  banner.textContent = message;
  window.clearTimeout(errorTimer);
  if (authError) {
    // An expired token will not fix itself: keep the banner and offer the fix.
    const reconnect = document.createElement("button");
    reconnect.type = "button";
    reconnect.className = "tab";
    reconnect.textContent = "Reconnect";
    reconnect.addEventListener("click", () => post({ type: "reconnect" }));
    banner.append(" ", reconnect);
  } else {
    errorTimer = window.setTimeout(clearError, 5000);
  }
  banner.hidden = false;
  setRefreshing(false);
  // A failure before the first state would otherwise leave skeletons pulsing forever.
  document.querySelectorAll(".skeleton-row").forEach((row) => row.remove());
}

function clearError(): void {
  window.clearTimeout(errorTimer);
  const banner = byId<HTMLDivElement>("error-banner");
  banner.hidden = true;
  banner.textContent = "";
}

let lastFetchedAt: number | undefined;

/** Shows how stale the data is once it is over a minute old. */
function updateCacheBanner(): void {
  const text = describeCacheAge(lastFetchedAt, Date.now());
  const banner = byId<HTMLDivElement>("cache-banner");
  banner.hidden = text === null;
  byId<HTMLSpanElement>("cache-banner-text").textContent = text ?? "";
}

function setRefreshing(refreshing: boolean): void {
  const button = byId<HTMLButtonElement>("refresh-button");
  button.disabled = refreshing;
  button.textContent = refreshing ? "\u21BB Refreshing…" : "\u21BB Refresh";
  document.body.setAttribute("aria-busy", String(refreshing));
}

let toastTimer: number | undefined;

function showToast(message: string): void {
  const toast = byId<HTMLDivElement>("toast");
  toast.textContent = message;
  toast.className = "toast toast-success";
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 3000);
}

function formatDate(value: string | null): string {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString();
}

function findMilestone(milestoneId: string | null): MilestoneView | undefined {
  if (!milestoneId) {
    return undefined;
  }
  return currentMilestones.find((candidate) => candidate.id === milestoneId);
}

function renderLabelBadges(labels: readonly string[]): string {
  if (labels.length === 0) {
    return "";
  }
  return `<span class="badges">${labels
    .map((label) => `<span class="badge">${escapeHtml(label)}</span>`)
    .join("")}</span>`;
}

function renderEmptyState(
  message: string,
  actionLabel: string | null,
  onAction: () => void,
): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "empty-state";
  const text = document.createElement("p");
  text.textContent = message;
  wrapper.appendChild(text);
  if (actionLabel) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab";
    button.textContent = actionLabel;
    button.addEventListener("click", onAction);
    wrapper.appendChild(button);
  }
  return wrapper;
}

function renderIssueList(): void {
  const list = byId<HTMLDivElement>("issue-list");
  list.innerHTML = "";
  const filtered = filterIssues(currentIssues, issueFilter, currentUser?.username ?? null);
  const sections = groupIssues(
    sortIssues(filtered, issueSort),
    issueGroup,
    new Map(currentMilestones.map((milestone) => [milestone.id, milestone.title])),
  );

  visibleIssueIds = [];
  if (filtered.length === 0) {
    list.appendChild(
      renderEmptyState(
        currentIssues.length === 0
          ? "No issues in this repository yet."
          : "No issues match the current filters.",
        currentIssues.length === 0 ? null : "Clear filters",
        () => setIssueFilter(EMPTY_FILTER),
      ),
    );
    return;
  }
  // Paging counts issues across sections: stop once the page is full.
  let remainingSlots = issueListPageSize;
  for (const section of sections) {
    if (remainingSlots <= 0) {
      break;
    }
    const visible = section.issues.slice(0, remainingSlots);
    remainingSlots -= visible.length;
    if (section.title) {
      const header = document.createElement("div");
      header.className = "group-header";
      header.textContent = `${section.title} (${section.issues.length})`;
      list.appendChild(header);
    }
    for (const issue of visible) {
      visibleIssueIds.push(issue.id);
      const item = document.createElement("div");
      item.className = "item" + (issue.id === selectedIssueId ? " selected" : "");
      item.dataset.issueId = issue.id;
      const stateClass = issue.state === "closed" ? " state-closed" : "";
      item.innerHTML = `<span class="number">#${issue.number}</span><span class="${stateClass}">${escapeHtml(issue.title)}</span>${renderLabelBadges(issue.labels)}`;
      item.addEventListener("click", () => {
        selectedIssueId = issue.id;
        showNewIssueForm = false;
        renderIssueList();
        renderIssueDetail();
      });
      list.appendChild(item);
    }
  }
  if (filtered.length > issueListPageSize) {
    const loadMore = document.createElement("button");
    loadMore.type = "button";
    loadMore.className = "load-more";
    loadMore.textContent = `Load more (${filtered.length - issueListPageSize} remaining)`;
    loadMore.addEventListener("click", () => {
      issueListPageSize += LIST_PAGE_SIZE;
      renderIssueList();
    });
    list.appendChild(loadMore);
  }
}

function renderNewIssueForm(): void {
  const detail = byId<HTMLDivElement>("issue-detail");
  const milestoneOptions = currentMilestones
    .map(
      (milestone) =>
        `<option value="${escapeAttr(milestone.id)}">${escapeHtml(milestone.title)}</option>`,
    )
    .join("");
  detail.innerHTML = `
    <h3>New Issue</h3>

    <label for="new-issue-title">Title</label>
    <input id="new-issue-title" type="text" />

    <label for="new-issue-body">Body</label>
    <textarea id="new-issue-body"></textarea>

    <label for="new-issue-milestone">Milestone</label>
    <select id="new-issue-milestone">
      <option value="">—</option>
      ${milestoneOptions}
    </select>

    <button id="new-issue-create" type="button">Create</button>
    <button id="new-issue-cancel" type="button">Cancel</button>
  `;

  byId<HTMLButtonElement>("new-issue-cancel").addEventListener("click", () => {
    showNewIssueForm = false;
    renderIssueDetail();
  });

  byId<HTMLButtonElement>("new-issue-create").addEventListener("click", () => {
    const title = byId<HTMLInputElement>("new-issue-title").value.trim();
    if (!title) {
      showError("Title is required.");
      return;
    }
    const body = byId<HTMLTextAreaElement>("new-issue-body").value;
    const milestoneId = byId<HTMLSelectElement>("new-issue-milestone").value || null;
    post({ type: "createIssue", input: { title, body, milestoneId } });
    showNewIssueForm = false;
  });
}

function renderIssueDetail(): void {
  const detail = byId<HTMLDivElement>("issue-detail");
  if (showNewIssueForm) {
    renderNewIssueForm();
    return;
  }
  const issue = currentIssues.find((candidate) => candidate.id === selectedIssueId);
  if (!issue) {
    detail.innerHTML = `<p>Select an issue to view details.</p>`;
    return;
  }

  const canWrite = currentCapabilities.canWriteIssues;
  const milestone = findMilestone(issue.milestoneId);
  const isAssignedToMe = currentUser !== null && issue.assignees.includes(currentUser.username);
  const showAssignToMe = canWrite && currentUser !== null && !isAssignedToMe;
  const labelOptions = Array.from(new Set([...currentAvailableLabels, ...issue.labels])).sort();
  const assigneeOptions = Array.from(
    new Set([...currentAvailableAssignableUsers, ...issue.assignees]),
  ).sort();
  detail.innerHTML = `
    <div class="meta">
      <div class="meta-row"><span class="meta-key">Number</span><span class="meta-value">#${issue.number}</span></div>
      <div class="meta-row"><span class="meta-key">Link</span><span class="meta-value"><a href="${escapeAttr(safeHref(issue.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(issue.url)}</a></span></div>
      <div class="meta-row"><span class="meta-key">Branch</span><span class="meta-value"><button id="issue-create-branch" type="button" class="assign-to-me">Create branch</button></span></div>
      <div class="meta-row"><span class="meta-key">Milestone</span><span class="meta-value">${milestone ? escapeHtml(milestone.title) : "—"}</span></div>
      <div class="meta-row"><span class="meta-key">Labels</span><span class="meta-value">${issue.labels.length > 0 ? renderLabelBadges(issue.labels) : "—"}</span></div>
      <div class="meta-row">
        <span class="meta-key">Assignees</span>
        <span class="meta-value">
          ${issue.assignees.length > 0 ? issue.assignees.map(escapeHtml).join(", ") : "—"}
          ${showAssignToMe ? '<button id="issue-assign-to-me" type="button" class="assign-to-me">Assign to me</button>' : ""}
        </span>
      </div>
      <div class="meta-row"><span class="meta-key">Comments</span><span class="meta-value"><a href="${escapeAttr(safeHref(issue.url))}" target="_blank" rel="noopener noreferrer">${issue.commentsCount}</a></span></div>
      <div class="meta-row"><span class="meta-key">Created</span><span class="meta-value">${formatDate(issue.createdAt)}</span></div>
      <div class="meta-row"><span class="meta-key">Updated</span><span class="meta-value">${formatDate(issue.updatedAt)}</span></div>
      <div class="meta-row"><span class="meta-key">Closed</span><span class="meta-value">${formatDate(issue.closedAt)}</span></div>
    </div>

    <label for="issue-title">Title</label>
    <input id="issue-title" type="text" value="${escapeAttr(issue.title)}" ${canWrite ? "" : "disabled"} />

    <label for="issue-state">State</label>
    <select id="issue-state" ${canWrite ? "" : "disabled"}>
      <option value="open" ${issue.state === "open" ? "selected" : ""}>Open</option>
      <option value="closed" ${issue.state === "closed" ? "selected" : ""}>Closed</option>
    </select>

    <label for="issue-milestone-editor">Milestone</label>
    <select id="issue-milestone-editor" ${canWrite ? "" : "disabled"}>
      <option value="">—</option>
      ${currentMilestones
        .map(
          (candidate) =>
            `<option value="${escapeAttr(candidate.id)}" ${issue.milestoneId === candidate.id ? "selected" : ""}>${escapeHtml(candidate.title)}</option>`,
        )
        .join("")}
    </select>

    <label for="issue-labels-editor">Labels</label>
    <div id="issue-labels-editor" class="checkbox-list">
      ${
        labelOptions.length > 0
          ? labelOptions
              .map(
                (label) =>
                  `<label><input type="checkbox" value="${escapeAttr(label)}" ${issue.labels.includes(label) ? "checked" : ""} ${canWrite ? "" : "disabled"} /> ${escapeHtml(label)}</label>`,
              )
              .join("")
          : `<span class="read-only-note">No labels available on this repository.</span>`
      }
    </div>

    <label for="issue-assignees-editor">Assignees</label>
    <div id="issue-assignees-editor" class="checkbox-list">
      ${
        assigneeOptions.length > 0
          ? assigneeOptions
              .map(
                (username) =>
                  `<label><input type="checkbox" value="${escapeAttr(username)}" ${issue.assignees.includes(username) ? "checked" : ""} ${canWrite ? "" : "disabled"} /> ${escapeHtml(username)}</label>`,
              )
              .join("")
          : `<span class="read-only-note">No assignable users found for this repository.</span>`
      }
    </div>

    <label for="issue-body">Body</label>
    <textarea id="issue-body" ${canWrite ? "" : "disabled"}>${escapeHtml(issue.body)}</textarea>

    <button id="issue-save" ${canWrite ? "" : "disabled"}>Save</button>
    ${canWrite ? "" : '<p class="read-only-note">Your account does not have write access to issues.</p>'}
  `;

  byId<HTMLButtonElement>("issue-create-branch").addEventListener("click", () => {
    post({ type: "createBranchForIssue", id: issue.id });
  });

  if (canWrite) {
    byId<HTMLButtonElement>("issue-save").addEventListener("click", () => {
      const title = byId<HTMLInputElement>("issue-title").value;
      const state = byId<HTMLSelectElement>("issue-state").value as "open" | "closed";
      const body = byId<HTMLTextAreaElement>("issue-body").value;
      const labels = Array.from(
        byId<HTMLDivElement>("issue-labels-editor").querySelectorAll<HTMLInputElement>(
          "input[type=checkbox]:checked",
        ),
      ).map((checkbox) => checkbox.value);
      const assignees = Array.from(
        byId<HTMLDivElement>("issue-assignees-editor").querySelectorAll<HTMLInputElement>(
          "input[type=checkbox]:checked",
        ),
      ).map((checkbox) => checkbox.value);
      const milestoneId = byId<HTMLSelectElement>("issue-milestone-editor").value || null;
      post({
        type: "updateIssue",
        id: issue.id,
        patch: { title, state, body, labels, assignees, milestoneId },
      });
    });

    if (showAssignToMe && currentUser !== null) {
      const username = currentUser.username;
      document.getElementById("issue-assign-to-me")?.addEventListener("click", () => {
        post({
          type: "updateIssue",
          id: issue.id,
          patch: { assignees: [...issue.assignees, username] },
        });
      });
    }
  }
}

function milestoneProgress(milestone: MilestoneView): MilestoneProgress {
  const linkedStates = currentIssues
    .filter((candidate) => candidate.milestoneId === milestone.id)
    .map((candidate) => candidate.state);
  return computeMilestoneProgress(milestone, linkedStates, new Date());
}

/**
 * Progress bar with a text alternative; overdue is shown by a warning mark,
 * not colour alone. A native `<progress>` is used because the webview CSP
 * forbids inline `style` attributes, which a width-based bar would need.
 */
function renderProgressBar(progress: MilestoneProgress): string {
  const summary = `${progress.closed} of ${progress.total} issues closed (${progress.percent}%)`;
  const due = describeDue(progress);
  return `<div class="progress-block${progress.overdue ? " overdue" : ""}">
    <progress class="progress" max="100" value="${progress.percent}" aria-label="${escapeAttr(summary)}"></progress>
    <div class="progress-caption"><span>${escapeHtml(summary)}</span><span class="progress-due">${progress.overdue ? "&#9888; " : ""}${escapeHtml(due)}</span></div>
  </div>`;
}

function renderMilestoneList(): void {
  const list = byId<HTMLDivElement>("milestone-list");
  list.innerHTML = "";
  const milestones =
    milestoneStateFilter === "all"
      ? currentMilestones
      : currentMilestones.filter((candidate) => candidate.state === milestoneStateFilter);
  if (milestones.length === 0) {
    list.appendChild(
      renderEmptyState(
        currentMilestones.length === 0
          ? "No milestones in this repository yet."
          : "No milestones match the current filter.",
        null,
        () => undefined,
      ),
    );
    return;
  }
  const visibleMilestones = milestones.slice(0, milestoneListPageSize);
  for (const milestone of visibleMilestones) {
    const item = document.createElement("div");
    item.className = "item" + (milestone.id === selectedMilestoneId ? " selected" : "");
    const stateClass = milestone.state === "closed" ? " state-closed" : "";
    const due = milestone.dueOn
      ? `<span class="due">Due ${formatDate(milestone.dueOn)}</span>`
      : "";
    item.innerHTML = `<span class="${stateClass}">${escapeHtml(milestone.title)}</span>${due}${renderProgressBar(milestoneProgress(milestone))}`;
    item.addEventListener("click", () => {
      selectedMilestoneId = milestone.id;
      showNewMilestoneForm = false;
      renderMilestoneList();
      renderMilestoneDetail();
    });
    list.appendChild(item);
  }
  if (milestones.length > visibleMilestones.length) {
    const loadMore = document.createElement("button");
    loadMore.type = "button";
    loadMore.className = "load-more";
    loadMore.textContent = `Load more (${milestones.length - visibleMilestones.length} remaining)`;
    loadMore.addEventListener("click", () => {
      milestoneListPageSize += LIST_PAGE_SIZE;
      renderMilestoneList();
    });
    list.appendChild(loadMore);
  }
}

function renderNewMilestoneForm(): void {
  const detail = byId<HTMLDivElement>("milestone-detail");
  detail.innerHTML = `
    <h3>New Milestone</h3>

    <label for="new-milestone-title">Title</label>
    <input id="new-milestone-title" type="text" />

    <label for="new-milestone-description">Description</label>
    <textarea id="new-milestone-description"></textarea>

    <label for="new-milestone-due">Due date</label>
    <input id="new-milestone-due" type="date" />

    <button id="new-milestone-create" type="button">Create</button>
    <button id="new-milestone-cancel" type="button">Cancel</button>
  `;

  byId<HTMLButtonElement>("new-milestone-cancel").addEventListener("click", () => {
    showNewMilestoneForm = false;
    renderMilestoneDetail();
  });

  byId<HTMLButtonElement>("new-milestone-create").addEventListener("click", () => {
    const title = byId<HTMLInputElement>("new-milestone-title").value.trim();
    if (!title) {
      showError("Title is required.");
      return;
    }
    const description = byId<HTMLTextAreaElement>("new-milestone-description").value;
    const dueOn = byId<HTMLInputElement>("new-milestone-due").value || null;
    post({ type: "createMilestone", input: { title, description, dueOn } });
    showNewMilestoneForm = false;
  });
}

function renderMilestoneDetail(): void {
  const detail = byId<HTMLDivElement>("milestone-detail");
  if (showNewMilestoneForm) {
    renderNewMilestoneForm();
    return;
  }
  const milestone = currentMilestones.find((candidate) => candidate.id === selectedMilestoneId);
  if (!milestone) {
    detail.innerHTML = `<p>Select a milestone to view details.</p>`;
    return;
  }

  const canWrite = currentCapabilities.canWriteMilestones;
  const linkedIssues = currentIssues.filter((candidate) => candidate.milestoneId === milestone.id);
  const openCount = linkedIssues.filter((candidate) => candidate.state === "open").length;
  const closedCount = linkedIssues.length - openCount;
  detail.innerHTML = `
    <div class="meta">
      <div class="meta-row"><span class="meta-key">Number</span><span class="meta-value">#${milestone.number}</span></div>
      <div class="meta-row"><span class="meta-key">Link</span><span class="meta-value"><a href="${escapeAttr(safeHref(milestone.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(milestone.url)}</a></span></div>
      <div class="meta-row"><span class="meta-key">Due</span><span class="meta-value">${formatDate(milestone.dueOn)}</span></div>
      <div class="meta-row"><span class="meta-key">Issues</span><span class="meta-value">${openCount} open, ${closedCount} closed <button id="milestone-view-issues" type="button" class="assign-to-me">View issues</button></span></div>
      <div class="meta-row"><span class="meta-key">Created</span><span class="meta-value">${formatDate(milestone.createdAt)}</span></div>
      <div class="meta-row"><span class="meta-key">Updated</span><span class="meta-value">${formatDate(milestone.updatedAt)}</span></div>
    </div>

    ${renderProgressBar(milestoneProgress(milestone))}

    <label for="milestone-title">Title</label>
    <input id="milestone-title" type="text" value="${escapeAttr(milestone.title)}" ${canWrite ? "" : "disabled"} />

    <label for="milestone-state">State</label>
    <select id="milestone-state" ${canWrite ? "" : "disabled"}>
      <option value="open" ${milestone.state === "open" ? "selected" : ""}>Open</option>
      <option value="closed" ${milestone.state === "closed" ? "selected" : ""}>Closed</option>
    </select>

    <label for="milestone-description">Description</label>
    <textarea id="milestone-description" ${canWrite ? "" : "disabled"}>${escapeHtml(milestone.description)}</textarea>

    <label for="milestone-due-editor">Due date</label>
    <input
      id="milestone-due-editor"
      type="date"
      value="${milestone.dueOn ? escapeAttr(milestone.dueOn.slice(0, 10)) : ""}"
      ${canWrite ? "" : "disabled"}
    />

    <button id="milestone-save" ${canWrite ? "" : "disabled"}>Save</button>
    ${canWrite ? "" : '<p class="read-only-note">Your account does not have write access to milestones.</p>'}
  `;

  byId<HTMLButtonElement>("milestone-view-issues").addEventListener("click", () => {
    setIssueFilter({ ...EMPTY_FILTER, milestone: milestone.id });
    setActiveTab("issues");
  });

  if (canWrite) {
    byId<HTMLButtonElement>("milestone-save").addEventListener("click", () => {
      const title = byId<HTMLInputElement>("milestone-title").value;
      const state = byId<HTMLSelectElement>("milestone-state").value as "open" | "closed";
      const description = byId<HTMLTextAreaElement>("milestone-description").value;
      const dueOn = byId<HTMLInputElement>("milestone-due-editor").value || null;
      post({
        type: "updateMilestone",
        id: milestone.id,
        patch: { title, state, description, dueOn },
      });
    });
  }
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

/**
 * Validates `url` is `http:`/`https:` before it's used as an `href`.
 * `issue.url`/`milestone.url` come straight from the provider's raw API
 * response — `escapeAttr` alone only entity-escapes the string, it
 * doesn't restrict the scheme, so a `javascript:` URL from a
 * compromised/malicious provider would otherwise pass through
 * unmodified into a clickable link. Falls back to `"#"` for anything
 * else (never renders the rejected value at all, not even escaped).
 */
function safeHref(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : "#";
  } catch {
    return "#";
  }
}

function renderRepositoryPicker(options: RepositoryOptionView[]): void {
  byId<HTMLDivElement>("repository-picker").hidden = false;
  byId<HTMLDivElement>("view-issues").hidden = true;
  byId<HTMLDivElement>("view-milestones").hidden = true;

  const container = byId<HTMLDivElement>("repository-options");
  container.innerHTML = "";
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "repository-option";
    button.textContent = option.label;
    button.addEventListener("click", () => {
      post({ type: "selectRepository", id: option.id });
    });
    container.appendChild(button);
  }
}

function renderIssueLabelFilterOptions(): void {
  const select = byId<HTMLSelectElement>("issue-label-filter");
  const previousValue = select.value;
  select.innerHTML =
    `<option value="">All labels</option>` +
    currentAvailableLabels
      .map((label) => `<option value="${escapeAttr(label)}">${escapeHtml(label)}</option>`)
      .join("");
  select.value = currentAvailableLabels.includes(previousValue) ? previousValue : "";
  if ((select.value || null) !== issueFilter.label) {
    issueFilter = { ...issueFilter, label: select.value || null };
  }
}

function renderIssueAssigneeFilterOptions(): void {
  const select = byId<HTMLSelectElement>("issue-assignee-filter");
  const previousValue = select.value;
  const usernames = currentAvailableAssignableUsers;
  select.innerHTML =
    `<option value="">All assignees</option><option value="@me">Assigned to me</option>` +
    usernames
      .map((username) => `<option value="${escapeAttr(username)}">${escapeHtml(username)}</option>`)
      .join("");
  select.value = previousValue === "@me" || usernames.includes(previousValue) ? previousValue : "";
  if ((select.value || null) !== issueFilter.assignee) {
    issueFilter = { ...issueFilter, assignee: select.value || null };
  }
}

/** Replaces the issue filter, resets paging, and re-renders the list and its controls. */
function setIssueFilter(next: IssueFilter): void {
  issueFilter = next;
  issueListPageSize = LIST_PAGE_SIZE;
  syncFilterControls();
  renderIssueList();
  renderBoardIfVisible();
}

function persistListPrefs(): void {
  uiPrefs = { ...uiPrefs, issueSort, issueGroup };
  post({ type: "saveUiPrefs", prefs: uiPrefs });
}

function persistSavedFilters(): void {
  uiPrefs = { ...uiPrefs, savedFilters };
  post({ type: "saveUiPrefs", prefs: uiPrefs });
}

/** Makes every filter control reflect {@link issueFilter} and the saved-filter list. */
function syncFilterControls(): void {
  byId<HTMLInputElement>("issue-search").value = issueFilter.query;
  byId<HTMLSelectElement>("issue-label-filter").value = issueFilter.label ?? "";
  byId<HTMLSelectElement>("issue-assignee-filter").value = issueFilter.assignee ?? "";
  byId<HTMLSelectElement>("issue-state-filter").value = issueFilter.state;

  const milestoneSelect = byId<HTMLSelectElement>("issue-milestone-filter");
  milestoneSelect.innerHTML =
    `<option value="">All milestones</option><option value="${NO_MILESTONE}">No milestone</option>` +
    currentMilestones
      .map(
        (milestone) =>
          `<option value="${escapeAttr(milestone.id)}">${escapeHtml(milestone.title)}</option>`,
      )
      .join("");
  milestoneSelect.value = issueFilter.milestone ?? "";

  const sortSelect = byId<HTMLSelectElement>("issue-sort");
  sortSelect.innerHTML = ISSUE_SORTS.map(
    (entry) => `<option value="${entry.value}">${escapeHtml(entry.label)}</option>`,
  ).join("");
  sortSelect.value = issueSort;
  const groupSelect = byId<HTMLSelectElement>("issue-group");
  groupSelect.innerHTML = ISSUE_GROUPS.map(
    (entry) => `<option value="${entry.value}">${escapeHtml(entry.label)}</option>`,
  ).join("");
  groupSelect.value = issueGroup;

  const matching = [...PRESET_FILTERS, ...savedFilters].find((entry) =>
    sameFilter(entry.filter, issueFilter),
  );
  const savedSelect = byId<HTMLSelectElement>("issue-saved-filters");
  const option = (entry: SavedFilter): string =>
    `<option value="${escapeAttr(entry.name)}">${escapeHtml(entry.name)}</option>`;
  savedSelect.innerHTML =
    `<option value="">Saved filters…</option>` +
    `<optgroup label="Built-in">${PRESET_FILTERS.map(option).join("")}</optgroup>` +
    (savedFilters.length > 0
      ? `<optgroup label="Yours">${savedFilters.map(option).join("")}</optgroup>`
      : "");
  savedSelect.value = matching?.name ?? "";
  byId<HTMLButtonElement>("issue-filter-delete").hidden =
    !matching || !savedFilters.some((entry) => entry.name === matching.name);
}

type TabName = "issues" | "milestones" | "board";

function activeTab(): TabName {
  for (const tab of ["milestones", "board"] as const) {
    if (byId<HTMLButtonElement>(`tab-${tab}`).classList.contains("active")) {
      return tab;
    }
  }
  return "issues";
}

function setActiveTab(tab: TabName): void {
  for (const name of ["issues", "milestones", "board"] as const) {
    byId<HTMLButtonElement>(`tab-${name}`).classList.toggle("active", tab === name);
    byId<HTMLDivElement>(`view-${name}`).hidden = tab !== name;
  }
  if (tab === "board") {
    renderBoard();
  }
}

function renderBoardIfVisible(): void {
  if (activeTab() === "board") {
    renderBoard();
  }
}

/** Applies a board move, enforcing write access client-side too (the host re-checks). */
function moveIssueToColumn(issueId: string, column: BoardColumnId): void {
  const issue = currentIssues.find((candidate) => candidate.id === issueId);
  if (!issue) {
    return;
  }
  if (!currentCapabilities.canWriteIssues) {
    showError("Your account does not have write access to issues.");
    return;
  }
  const patch = planBoardMove(issue, column);
  if (patch) {
    post({ type: "updateIssue", id: issue.id, patch });
  }
}

function renderBoard(): void {
  const container = byId<HTMLDivElement>("board");
  container.innerHTML = "";
  const canWrite = currentCapabilities.canWriteIssues;
  const visible = sortIssues(
    filterIssues(currentIssues, issueFilter, currentUser?.username ?? null),
    issueSort,
  );
  byId<HTMLParagraphElement>("board-note").textContent =
    `${visible.length} issue${visible.length === 1 ? "" : "s"} shown. The filters of the Issues tab apply.` +
    (canWrite ? " Drag a card, or use its Move menu, to change its status." : "");

  for (const column of buildBoard(visible)) {
    const section = document.createElement("section");
    section.className = "board-column";
    section.setAttribute("aria-label", `${column.title}, ${column.issues.length} issues`);
    const header = document.createElement("h3");
    header.textContent = `${column.title} (${column.issues.length})`;
    section.appendChild(header);

    section.addEventListener("dragover", (event) => {
      if (canWrite) {
        event.preventDefault();
        section.classList.add("drop-target");
      }
    });
    section.addEventListener("dragleave", () => section.classList.remove("drop-target"));
    section.addEventListener("drop", (event) => {
      event.preventDefault();
      section.classList.remove("drop-target");
      const issueId = event.dataTransfer?.getData("text/plain");
      if (issueId) {
        moveIssueToColumn(issueId, column.id);
      }
    });

    for (const issue of column.issues) {
      const card = document.createElement("article");
      card.className = "board-card";
      card.draggable = canWrite;
      card.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData("text/plain", issue.id);
      });

      const title = document.createElement("button");
      title.type = "button";
      title.className = "board-card-title";
      title.innerHTML = `<span class="number">#${issue.number}</span> ${escapeHtml(issue.title)}`;
      title.addEventListener("click", () => {
        selectedIssueId = issue.id;
        showNewIssueForm = false;
        setActiveTab("issues");
        renderIssueList();
        renderIssueDetail();
      });
      card.appendChild(title);
      card.insertAdjacentHTML("beforeend", renderLabelBadges(issue.labels));

      const move = document.createElement("select");
      move.className = "board-card-move";
      move.disabled = !canWrite;
      move.setAttribute("aria-label", `Move issue #${issue.number}`);
      move.innerHTML =
        `<option value="">Move to…</option>` +
        BOARD_COLUMNS.filter((target) => target.id !== column.id)
          .map((target) => `<option value="${target.id}">${escapeHtml(target.title)}</option>`)
          .join("");
      move.addEventListener("change", () => {
        if (move.value) {
          moveIssueToColumn(issue.id, move.value as BoardColumnId);
        }
      });
      card.appendChild(move);
      section.appendChild(card);
    }
    container.appendChild(section);
  }
}

byId<HTMLButtonElement>("tab-issues").addEventListener("click", () => {
  setIssueFilter(EMPTY_FILTER);
  setActiveTab("issues");
});
byId<HTMLInputElement>("issue-search").addEventListener("input", (event) => {
  setIssueFilter({ ...issueFilter, query: (event.target as HTMLInputElement).value });
});
byId<HTMLSelectElement>("issue-label-filter").addEventListener("change", (event) => {
  setIssueFilter({ ...issueFilter, label: (event.target as HTMLSelectElement).value || null });
});
byId<HTMLSelectElement>("issue-assignee-filter").addEventListener("change", (event) => {
  setIssueFilter({ ...issueFilter, assignee: (event.target as HTMLSelectElement).value || null });
});
byId<HTMLSelectElement>("issue-state-filter").addEventListener("change", (event) => {
  setIssueFilter({
    ...issueFilter,
    state: (event.target as HTMLSelectElement).value as IssueFilter["state"],
  });
});
byId<HTMLSelectElement>("issue-milestone-filter").addEventListener("change", (event) => {
  setIssueFilter({ ...issueFilter, milestone: (event.target as HTMLSelectElement).value || null });
});
byId<HTMLSelectElement>("issue-sort").addEventListener("change", (event) => {
  issueSort = (event.target as HTMLSelectElement).value as IssueSort;
  persistListPrefs();
  renderIssueList();
});
byId<HTMLSelectElement>("issue-group").addEventListener("change", (event) => {
  issueGroup = (event.target as HTMLSelectElement).value as IssueGroup;
  persistListPrefs();
  renderIssueList();
});
byId<HTMLSelectElement>("issue-saved-filters").addEventListener("change", (event) => {
  const name = (event.target as HTMLSelectElement).value;
  const chosen = [...PRESET_FILTERS, ...savedFilters].find((entry) => entry.name === name);
  if (chosen) {
    setIssueFilter(chosen.filter);
  }
});
byId<HTMLButtonElement>("issue-filter-save").addEventListener("click", () => {
  byId<HTMLSpanElement>("saved-filter-form").hidden = false;
  byId<HTMLInputElement>("saved-filter-name").focus();
});
byId<HTMLButtonElement>("saved-filter-cancel").addEventListener("click", () => {
  byId<HTMLSpanElement>("saved-filter-form").hidden = true;
  byId<HTMLInputElement>("saved-filter-name").value = "";
});
byId<HTMLButtonElement>("saved-filter-confirm").addEventListener("click", () => {
  const input = byId<HTMLInputElement>("saved-filter-name");
  const next = upsertSavedFilter(savedFilters, input.value, issueFilter);
  if (!next) {
    showError("Enter a name that is not one of the built-in filters.");
    return;
  }
  savedFilters = next;
  persistSavedFilters();
  input.value = "";
  byId<HTMLSpanElement>("saved-filter-form").hidden = true;
  syncFilterControls();
});
byId<HTMLButtonElement>("issue-filter-delete").addEventListener("click", () => {
  const name = byId<HTMLSelectElement>("issue-saved-filters").value;
  savedFilters = removeSavedFilter(savedFilters, name);
  persistSavedFilters();
  syncFilterControls();
});
byId<HTMLSelectElement>("milestone-state-filter").addEventListener("change", (event) => {
  milestoneStateFilter = (event.target as HTMLSelectElement).value as "all" | "open" | "closed";
  milestoneListPageSize = LIST_PAGE_SIZE;
  renderMilestoneList();
});
byId<HTMLButtonElement>("tab-milestones").addEventListener("click", () =>
  setActiveTab("milestones"),
);
byId<HTMLButtonElement>("tab-board").addEventListener("click", () => setActiveTab("board"));
byId<HTMLButtonElement>("issue-new").addEventListener("click", () => {
  selectedIssueId = null;
  showNewIssueForm = true;
  renderIssueList();
  renderIssueDetail();
});
byId<HTMLButtonElement>("milestone-new").addEventListener("click", () => {
  selectedMilestoneId = null;
  showNewMilestoneForm = true;
  renderMilestoneList();
  renderMilestoneDetail();
});
function requestRefresh(): void {
  setRefreshing(true);
  post({ type: "requestState", forceRefresh: true });
}
byId<HTMLButtonElement>("refresh-button").addEventListener("click", requestRefresh);
byId<HTMLButtonElement>("cache-banner-refresh").addEventListener("click", requestRefresh);
window.setInterval(updateCacheBanner, 30_000);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function toggleShortcutHelp(force?: boolean): void {
  const help = byId<HTMLDivElement>("shortcut-help");
  help.hidden = force === undefined ? !help.hidden : !force;
  if (!help.hidden) {
    help.innerHTML = `<h3>Keyboard shortcuts</h3><dl>${SHORTCUT_HELP.map(
      (entry) =>
        `<dt><kbd>${escapeHtml(entry.keys)}</kbd></dt><dd>${escapeHtml(entry.description)}</dd>`,
    ).join("")}</dl><p>Press <kbd>Esc</kbd> to close.</p>`;
  }
}

function selectIssueByKeyboard(direction: "next" | "previous"): void {
  const id = moveSelection(visibleIssueIds, selectedIssueId, direction);
  if (id === null || id === selectedIssueId) {
    return;
  }
  selectedIssueId = id;
  showNewIssueForm = false;
  renderIssueList();
  renderIssueDetail();
  document
    .querySelector<HTMLElement>(`#issue-list .item[data-issue-id="${CSS.escape(id)}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    toggleShortcutHelp(false);
    return;
  }
  const action = shortcutFor(event, isEditableTarget(event.target));
  const issuesVisible = !byId<HTMLDivElement>("view-issues").hidden;
  switch (action) {
    case "next":
    case "previous":
      if (issuesVisible) {
        event.preventDefault();
        selectIssueByKeyboard(action);
      }
      return;
    case "edit":
      if (issuesVisible && selectedIssueId !== null) {
        const title = document.getElementById("issue-title") as HTMLInputElement | null;
        if (title && !title.disabled) {
          event.preventDefault();
          title.focus();
          title.select();
        }
      }
      return;
    case "search":
      if (issuesVisible) {
        event.preventDefault();
        byId<HTMLInputElement>("issue-search").focus();
      }
      return;
    case "refresh":
      requestRefresh();
      return;
    case "help":
      toggleShortcutHelp();
      return;
    case null:
      return;
  }
});

window.addEventListener("message", (event: MessageEvent<OutboundMessage>) => {
  const message = event.data;
  if (message.type === "state") {
    clearError();
    byId<HTMLDivElement>("repository-picker").hidden = true;
    setActiveTab(activeTab());

    const snapshot: StateSnapshot = {
      issues: message.issues,
      milestones: message.milestones,
      capabilities: message.capabilities,
      currentUser: message.currentUser,
      availableLabels: message.availableLabels,
      availableAssignableUsers: message.availableAssignableUsers,
    };
    lastFetchedAt = message.dataFetchedAt;
    updateCacheBanner();
    setRefreshing(false);
    byId<HTMLDivElement>("issue-list").removeAttribute("aria-busy");
    if (!hasStateChanged(lastState, snapshot)) {
      return;
    }
    lastState = snapshot;

    currentIssues = message.issues;
    currentMilestones = message.milestones;
    currentCapabilities = message.capabilities;
    currentUser = message.currentUser;
    currentAvailableLabels = message.availableLabels;
    currentAvailableAssignableUsers = message.availableAssignableUsers;
    renderIssueLabelFilterOptions();
    renderIssueAssigneeFilterOptions();
    syncFilterControls();
    byId<HTMLButtonElement>("issue-new").disabled = !currentCapabilities.canWriteIssues;
    byId<HTMLButtonElement>("milestone-new").disabled = !currentCapabilities.canWriteMilestones;
    renderIssueList();
    renderBoardIfVisible();
    // Skip re-rendering the create form while it's open — the "state"
    // handler runs on every refresh/edit, and re-rendering would wipe
    // out an in-progress, unsaved draft (see #49).
    if (!showNewIssueForm) {
      renderIssueDetail();
    }
    renderMilestoneList();
    if (!showNewMilestoneForm) {
      renderMilestoneDetail();
    }
  } else if (message.type === "repositoryOptions") {
    clearError();
    renderRepositoryPicker(message.options);
  } else if (message.type === "selectIssue") {
    selectedIssueId = message.id;
    showNewIssueForm = false;
    setIssueFilter({ ...issueFilter, milestone: null });
    setActiveTab("issues");
    renderIssueDetail();
  } else if (message.type === "uiPrefs") {
    uiPrefs = { ...message.prefs };
    savedFilters = readSavedFilters(uiPrefs);
    ({ sort: issueSort, group: issueGroup } = readListPrefs(uiPrefs));
    syncFilterControls();
    renderIssueList();
  } else if (message.type === "openNewIssueForm") {
    selectedIssueId = null;
    showNewIssueForm = true;
    setActiveTab("issues");
    renderIssueList();
    renderIssueDetail();
  } else if (message.type === "openNewMilestoneForm") {
    selectedMilestoneId = null;
    showNewMilestoneForm = true;
    setActiveTab("milestones");
    renderMilestoneList();
    renderMilestoneDetail();
  } else if (message.type === "actionSuccess") {
    showToast(message.message);
  } else if (message.type === "error") {
    showError(message.message, message.authError === true);
  }
});

post({ type: "requestState" });
