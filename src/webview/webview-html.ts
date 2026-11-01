import * as vscode from "vscode";

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
<html lang="en">
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
  <div class="tabs">
    <button id="tab-issues" class="tab active" type="button">Issues</button>
    <button id="tab-board" class="tab" type="button">Board</button>
    <button id="tab-milestones" class="tab" type="button">Milestones</button>
    <button id="refresh-button" class="tab refresh" type="button" title="Refetch from the remote, bypassing the cache">&#8635; Refresh</button>
  </div>

  <div id="error-banner" class="error-banner" hidden></div>
  <div id="cache-banner" class="cache-banner" role="status" hidden>
    <span id="cache-banner-text"></span>
    <button id="cache-banner-refresh" class="tab" type="button">Refresh now</button>
  </div>
  <div id="toast" class="toast" hidden></div>
  <div id="shortcut-help" class="shortcut-help" role="dialog" aria-label="Keyboard shortcuts" hidden></div>

  <div id="repository-picker" class="repository-picker" hidden>
    <p>Multiple repositories were found in this workspace. Pick one:</p>
    <div id="repository-options"></div>
  </div>

  <div id="view-issues" class="view">
    <div class="list-column">
      <div class="list-toolbar">
        <input id="issue-search" type="text" placeholder="Search issues…" />
        <select id="issue-label-filter" title="Filter by label"><option value="">All labels</option></select>
        <select id="issue-assignee-filter" title="Filter by assignee">
          <option value="">All assignees</option>
          <option value="@me">Assigned to me</option>
        </select>
        <select id="issue-state-filter" title="Filter by state">
          <option value="all">All states</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </select>
        <select id="issue-milestone-filter" title="Filter by milestone">
          <option value="">All milestones</option>
        </select>
        <select id="issue-sort" title="Sort issues"></select>
        <select id="issue-group" title="Group issues"></select>
        <select id="issue-saved-filters" title="Apply a saved filter">
          <option value="">Saved filters…</option>
        </select>
        <button id="issue-filter-save" class="tab" type="button" title="Save the current filter">Save filter…</button>
        <button id="issue-filter-delete" class="tab" type="button" title="Delete this saved filter" hidden>Delete filter</button>
        <span id="saved-filter-form" class="saved-filter-form" hidden>
          <input id="saved-filter-name" type="text" placeholder="Filter name" />
          <button id="saved-filter-confirm" class="tab" type="button">Save</button>
          <button id="saved-filter-cancel" class="tab" type="button">Cancel</button>
        </span>
        <button id="issue-new" class="tab" type="button" disabled>+ New Issue</button>
      </div>
      <div class="list" id="issue-list" aria-busy="true" aria-label="Loading issues"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>
    </div>
    <div class="detail" id="issue-detail"></div>
  </div>

  <div id="view-board" class="view board-view" hidden>
    <p id="board-note" class="board-note"></p>
    <div id="board" class="board"></div>
  </div>

  <div id="view-milestones" class="view" hidden>
    <div class="list-column">
      <div class="list-toolbar">
        <select id="milestone-state-filter" title="Filter by state">
          <option value="all">All states</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </select>
        <button id="milestone-new" class="tab" type="button" disabled>+ New Milestone</button>
      </div>
      <div class="list" id="milestone-list" aria-busy="true" aria-label="Loading milestones"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>
    </div>
    <div class="detail" id="milestone-detail"></div>
  </div>

  <script nonce="${nonce}" type="module" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
