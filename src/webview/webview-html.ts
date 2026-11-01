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
  <div class="tabs" role="tablist" aria-label="Views">
    <button id="tab-issues" class="tab active" type="button" role="tab" aria-selected="true" aria-controls="view-issues">Issues</button>
    <button id="tab-board" class="tab" type="button" role="tab" aria-selected="false" aria-controls="view-board">Board</button>
    <button id="tab-milestones" class="tab" type="button" role="tab" aria-selected="false" aria-controls="view-milestones">Milestones</button>
    <button id="refresh-button" class="tab refresh" type="button" title="Refetch from the remote, bypassing the cache">&#8635; Refresh</button>
  </div>

  <div id="error-banner" class="error-banner" role="alert" hidden></div>
  <div id="cache-banner" class="cache-banner" role="status" hidden>
    <span id="cache-banner-text"></span>
    <button id="cache-banner-refresh" class="tab" type="button">Refresh now</button>
  </div>
  <div id="toast" class="toast" role="status" hidden></div>
  <div id="shortcut-help" class="shortcut-help" role="dialog" aria-label="Keyboard shortcuts" hidden></div>

  <div id="repository-picker" class="repository-picker" hidden>
    <p>Multiple repositories were found in this workspace. Pick one:</p>
    <div id="repository-options"></div>
  </div>

  <div id="view-issues" class="view" role="tabpanel" aria-label="Issues">
    <div class="list-column">
      <div class="list-toolbar">
        <input id="issue-search" type="text" placeholder="Search issues…" aria-label="Search issues" />
        <select id="issue-label-filter" title="Filter by label" aria-label="Filter by label"><option value="">All labels</option></select>
        <select id="issue-assignee-filter" title="Filter by assignee" aria-label="Filter by assignee">
          <option value="">All assignees</option>
          <option value="@me">Assigned to me</option>
        </select>
        <select id="issue-state-filter" title="Filter by state" aria-label="Filter by state">
          <option value="all">All states</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </select>
        <select id="issue-milestone-filter" title="Filter by milestone" aria-label="Filter by milestone">
          <option value="">All milestones</option>
        </select>
        <select id="issue-sort" title="Sort issues" aria-label="Sort issues"></select>
        <select id="issue-group" title="Group issues" aria-label="Group issues"></select>
        <select id="issue-saved-filters" title="Apply a saved filter" aria-label="Saved filters">
          <option value="">Saved filters…</option>
        </select>
        <button id="issue-filter-save" class="tab" type="button" title="Save the current filter">Save filter…</button>
        <button id="issue-filter-delete" class="tab" type="button" title="Delete this saved filter" hidden>Delete filter</button>
        <span id="saved-filter-form" class="saved-filter-form" hidden>
          <input id="saved-filter-name" type="text" placeholder="Filter name" aria-label="Filter name" />
          <button id="saved-filter-confirm" class="tab" type="button">Save</button>
          <button id="saved-filter-cancel" class="tab" type="button">Cancel</button>
        </span>
        <button id="issue-new" class="tab" type="button" disabled>+ New Issue</button>
      </div>
      <div class="list" id="issue-list" role="listbox" aria-label="Issues" aria-busy="true"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>
    </div>
    <div class="detail" id="issue-detail" role="region" aria-label="Issue details"></div>
  </div>

  <div id="view-board" class="view board-view" role="tabpanel" aria-label="Board" hidden>
    <p id="board-note" class="board-note"></p>
    <div id="board" class="board"></div>
  </div>

  <div id="view-milestones" class="view" role="tabpanel" aria-label="Milestones" hidden>
    <div class="list-column">
      <div class="list-toolbar">
        <select id="milestone-state-filter" title="Filter by state" aria-label="Filter milestones by state">
          <option value="all">All states</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </select>
        <button id="milestone-new" class="tab" type="button" disabled>+ New Milestone</button>
      </div>
      <div class="list" id="milestone-list" role="listbox" aria-label="Milestones" aria-busy="true"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>
    </div>
    <div class="detail" id="milestone-detail" role="region" aria-label="Milestone details"></div>
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
<html lang="en">
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
    <select id="issue-filter" title="Filter by issue"><option value="">All commits</option></select>
    <input id="text-filter" type="text" placeholder="Filter by message, author or hash…" />
    <button id="refresh" class="tab" type="button">&#8635; Refresh</button>
  </div>
  <p id="graph-note" class="board-note">Loading…</p>
  <div id="graph" class="graph" role="list"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
