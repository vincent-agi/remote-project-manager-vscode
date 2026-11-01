import * as vscode from "vscode";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Translates `message` for the page, HTML-escaped (it lands in text and attribute positions). */
function t(message: string): string {
  return escapeHtml(vscode.l10n.t(message));
}

/** BCP 47 tag of VS Code's display language, for `<html lang>` and the webview's own translations. */
function pageLanguage(): string {
  return escapeHtml(vscode.env.language);
}

/**
 * Builds the HTML shell for the central panel webview. The actual UI
 * logic lives in the bundled browser script at `dist/webview-ui/main.js`.
 */
export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview-ui", "main.js"),
  );
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "style.css"));
  const nonce = String(Math.floor(Math.random() * 1e18));

  return /* html */ `<!DOCTYPE html>
<html lang="${pageLanguage()}">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};"
  />
  <link href="${styleUri.toString()}" rel="stylesheet" />
  <title>Remote Project Manager</title>
</head>
<body>
  <div class="tabs" role="tablist" aria-label="${t("Views")}">
    <button id="tab-issues" class="tab active" type="button" role="tab" aria-selected="true" aria-controls="view-issues">${t("Issues")}</button>
    <button id="tab-board" class="tab" type="button" role="tab" aria-selected="false" aria-controls="view-board">${t("Board")}</button>
    <button id="tab-milestones" class="tab" type="button" role="tab" aria-selected="false" aria-controls="view-milestones">${t("Milestones")}</button>
    <button id="tab-settings" class="tab" type="button" role="tab" aria-selected="false" aria-controls="view-settings">${t("Settings")}</button>
    <button id="refresh-button" class="tab refresh" type="button" title="${t("Refetch from the remote, bypassing the cache")}">&#8635; ${t("Refresh")}</button>
    <select id="repository-switcher" class="repository-switcher" title="${t("Repository")}" aria-label="${t("Repository")}" hidden></select>
  </div>

  <div id="error-banner" class="error-banner" role="alert" hidden></div>
  <div id="cache-banner" class="cache-banner" role="status" hidden>
    <span id="cache-banner-text"></span>
    <button id="cache-banner-refresh" class="tab" type="button">${t("Refresh now")}</button>
  </div>
  <div id="toast" class="toast" role="status" hidden></div>
  <div id="shortcut-help" class="shortcut-help" role="dialog" aria-label="${t("Keyboard shortcuts")}" hidden></div>

  <div id="repository-picker" class="repository-picker" hidden>
    <p>${t("Multiple repositories were found in this workspace. Pick one:")}</p>
    <div id="repository-options"></div>
  </div>

  <div id="view-issues" class="view" role="tabpanel" aria-label="${t("Issues")}">
    <div class="list-column">
      <div class="list-toolbar">
        <input id="issue-search" type="text" placeholder="${t("Search issues…")}" aria-label="${t("Search issues")}" />
        <select id="issue-label-filter" title="${t("Filter by label")}" aria-label="${t("Filter by label")}"><option value="">${t("All labels")}</option></select>
        <select id="issue-assignee-filter" title="${t("Filter by assignee")}" aria-label="${t("Filter by assignee")}">
          <option value="">${t("All assignees")}</option>
          <option value="@me">${t("Assigned to me")}</option>
        </select>
        <select id="issue-state-filter" title="${t("Filter by state")}" aria-label="${t("Filter by state")}">
          <option value="all">${t("All states")}</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </select>
        <select id="issue-milestone-filter" title="${t("Filter by milestone")}" aria-label="${t("Filter by milestone")}">
          <option value="">${t("All milestones")}</option>
        </select>
        <select id="issue-sort" title="${t("Sort issues")}" aria-label="${t("Sort issues")}"></select>
        <select id="issue-group" title="${t("Group issues")}" aria-label="${t("Group issues")}"></select>
        <select id="issue-saved-filters" title="${t("Apply a saved filter")}" aria-label="${t("Saved filters")}">
          <option value="">${t("Saved filters…")}</option>
        </select>
        <button id="issue-filter-save" class="tab" type="button" title="${t("Save the current filter")}">${t("Save filter…")}</button>
        <button id="issue-filter-delete" class="tab" type="button" title="${t("Delete this saved filter")}" hidden>${t("Delete filter")}</button>
        <span id="saved-filter-form" class="saved-filter-form" hidden>
          <input id="saved-filter-name" type="text" placeholder="${t("Filter name")}" aria-label="${t("Filter name")}" />
          <button id="saved-filter-confirm" class="tab" type="button">${t("Save")}</button>
          <button id="saved-filter-cancel" class="tab" type="button">${t("Cancel")}</button>
        </span>
        <button id="issue-new" class="tab" type="button" disabled>+ ${t("New Issue")}</button>
      </div>
      <div class="list" id="issue-list" role="listbox" aria-label="${t("Issues")}" aria-busy="true"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>
    </div>
    <div class="detail" id="issue-detail" role="region" aria-label="${t("Issue details")}"></div>
  </div>

  <div id="view-board" class="view board-view" role="tabpanel" aria-label="${t("Board")}" hidden>
    <p id="board-note" class="board-note"></p>
    <div id="board" class="board"></div>
  </div>

  <div id="view-settings" class="view settings-view" role="tabpanel" aria-label="${t("Settings")}" hidden>
    <div id="settings" class="settings"></div>
  </div>

  <div id="view-milestones" class="view" role="tabpanel" aria-label="${t("Milestones")}" hidden>
    <div class="list-column">
      <div class="list-toolbar">
        <select id="milestone-state-filter" title="${t("Filter by state")}" aria-label="${t("Filter milestones by state")}">
          <option value="all">${t("All states")}</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </select>
        <button id="milestone-new" class="tab" type="button" disabled>+ ${t("New Milestone")}</button>
      </div>
      <div class="list" id="milestone-list" role="listbox" aria-label="${t("Milestones")}" aria-busy="true"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>
    </div>
    <div class="detail" id="milestone-detail" role="region" aria-label="${t("Milestone details")}"></div>
  </div>

  <script nonce="${nonce}" type="module" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}

/** HTML shell for the Git Graph panel; its logic lives in `dist/webview-ui/git-graph.js`. */
export function getGitGraphHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview-ui", "git-graph.js"),
  );
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "style.css"));
  const nonce = String(Math.floor(Math.random() * 1e18));

  return /* html */ `<!DOCTYPE html>
<html lang="${pageLanguage()}">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};"
  />
  <link href="${styleUri.toString()}" rel="stylesheet" />
  <title>Git Graph</title>
</head>
<body class="graph-page">
  <div class="list-toolbar">
    <select id="issue-filter" title="${t("Filter by issue")}"><option value="">${t("All commits")}</option></select>
    <input id="text-filter" type="text" placeholder="${t("Filter by message, author or hash…")}" />
    <button id="refresh" class="tab" type="button">&#8635; ${t("Refresh")}</button>
  </div>
  <p id="graph-note" class="board-note">${t("Loading…")}</p>
  <div id="graph" class="graph" role="list"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
