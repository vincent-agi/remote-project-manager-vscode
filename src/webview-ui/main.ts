// This file compiles to an ES module loaded with `<script type="module">`.
// Pure logic lives in sibling modules (imported with a `.js` extension, as
// the browser sees the compiled output) so it can be unit tested. The
// message shapes below are mirrored by hand from src/webview/messages.ts,
// because the host and webview programs have separate `rootDir`s.

import { hasStateChanged } from "./state-diff.js";
import {
  EMPTY_FILTER,
  filterIssues,
  NO_MILESTONE,
  PRESET_FILTERS,
  readSavedFilters,
  removeSavedFilter,
  sameFilter,
  upsertSavedFilter,
  type IssueFilter,
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
    }
  | { type: "uiPrefs"; prefs: Record<string, unknown> }
  | { type: "repositoryOptions"; options: RepositoryOptionView[] }
  | { type: "selectIssue"; id: string }
  | { type: "openNewIssueForm" }
  | { type: "openNewMilestoneForm" }
  | { type: "actionSuccess"; message: string }
  | { type: "error"; message: string };

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
  | { type: "saveUiPrefs"; prefs: Record<string, unknown> };

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

function showError(message: string): void {
  const banner = byId<HTMLDivElement>("error-banner");
  banner.textContent = message;
  banner.hidden = false;
  window.clearTimeout(errorTimer);
  errorTimer = window.setTimeout(clearError, 5000);
}

function clearError(): void {
  window.clearTimeout(errorTimer);
  const banner = byId<HTMLDivElement>("error-banner");
  banner.hidden = true;
  banner.textContent = "";
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

function renderIssueList(): void {
  const list = byId<HTMLDivElement>("issue-list");
  list.innerHTML = "";
  const issues = filterIssues(currentIssues, issueFilter, currentUser?.username ?? null);
  const visibleIssues = issues.slice(0, issueListPageSize);
  for (const issue of visibleIssues) {
    const item = document.createElement("div");
    item.className = "item" + (issue.id === selectedIssueId ? " selected" : "");
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
  if (issues.length > visibleIssues.length) {
    const loadMore = document.createElement("button");
    loadMore.type = "button";
    loadMore.className = "load-more";
    loadMore.textContent = `Load more (${issues.length - visibleIssues.length} remaining)`;
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

function renderMilestoneList(): void {
  const list = byId<HTMLDivElement>("milestone-list");
  list.innerHTML = "";
  const milestones =
    milestoneStateFilter === "all"
      ? currentMilestones
      : currentMilestones.filter((candidate) => candidate.state === milestoneStateFilter);
  const visibleMilestones = milestones.slice(0, milestoneListPageSize);
  for (const milestone of visibleMilestones) {
    const item = document.createElement("div");
    item.className = "item" + (milestone.id === selectedMilestoneId ? " selected" : "");
    const stateClass = milestone.state === "closed" ? " state-closed" : "";
    const due = milestone.dueOn
      ? `<span class="due">Due ${formatDate(milestone.dueOn)}</span>`
      : "";
    item.innerHTML = `<span class="${stateClass}">${escapeHtml(milestone.title)}</span>${due}`;
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

function setActiveTab(tab: "issues" | "milestones"): void {
  byId<HTMLButtonElement>("tab-issues").classList.toggle("active", tab === "issues");
  byId<HTMLButtonElement>("tab-milestones").classList.toggle("active", tab === "milestones");
  byId<HTMLDivElement>("view-issues").hidden = tab !== "issues";
  byId<HTMLDivElement>("view-milestones").hidden = tab !== "milestones";
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
byId<HTMLButtonElement>("refresh-button").addEventListener("click", () => {
  post({ type: "requestState", forceRefresh: true });
});

window.addEventListener("message", (event: MessageEvent<OutboundMessage>) => {
  const message = event.data;
  if (message.type === "state") {
    clearError();
    byId<HTMLDivElement>("repository-picker").hidden = true;
    setActiveTab(
      byId<HTMLButtonElement>("tab-milestones").classList.contains("active")
        ? "milestones"
        : "issues",
    );

    const snapshot: StateSnapshot = {
      issues: message.issues,
      milestones: message.milestones,
      capabilities: message.capabilities,
      currentUser: message.currentUser,
      availableLabels: message.availableLabels,
      availableAssignableUsers: message.availableAssignableUsers,
    };
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
    syncFilterControls();
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
    showError(message.message);
  }
});

post({ type: "requestState" });
