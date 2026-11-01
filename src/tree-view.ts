/** The sidebar tree of assigned issues, and the periodic refresh that keeps it and the badge current. */
import * as vscode from "vscode";
import { isAuthError } from "./core/auth/is-auth-error";
import type {
  IAuthenticatedUser,
  IProjectProvider,
} from "./core/providers/project-provider.interface";
import { repositoryKey } from "./core/workspace/repository-resolver";
import {
  buildIssueDescription,
  buildIssueTooltip,
  groupMyIssues,
  priorityOf,
  selectMyOpenIssues,
  workStatusOf,
  type MyIssueGroup,
  type MyIssueSummary,
} from "./core/tree/my-issues";
import { isPollDue, normalizePollInterval } from "./core/polling/poll-schedule";
import { logger } from "./logger";
import type { SyncState } from "./core/status/status-bar-model";
import { resolveRepository } from "./repository";
import { connectRepository } from "./connection";
import { state } from "./state";

/** Localized title of a tree group. */
function describeGroup(status: MyIssueGroup["status"]): string {
  switch (status) {
    case "in-progress":
      return vscode.l10n.t("In progress");
    case "todo":
      return vscode.l10n.t("To do");
    case "blocked":
      return vscode.l10n.t("Blocked");
  }
}

/** Theme colour per priority rank (0 = critical .. 3 = low). */
const PRIORITY_COLORS = ["charts.red", "charts.orange", "charts.yellow", "charts.blue"] as const;

/**
 * Populates the activity bar sidebar with the current user's assigned
 * open issues, so they're visible without opening the full panel. Lazily
 * connects on first reveal (VS Code calls `getChildren` when the view
 * becomes visible) and reuses that connection afterward, independently
 * of any panel connection — a separate token prompt/connect from the
 * panel's own, by design, so revealing the sidebar never depends on the
 * panel having been opened first.
 *
 * When no repository can be resolved unambiguously (none detected, or
 * multiple candidates the panel's webview picker would normally
 * disambiguate), or the connection fails for any reason, this silently
 * returns an empty list rather than prompting/erroring from a passive
 * sidebar reveal — VS Code then falls back to the `viewsWelcome` entry's
 * "Open Panel" link, which goes through the full picker/error UX.
 */
export class MyIssuesTreeDataProvider implements vscode.TreeDataProvider<
  MyIssueSummary | MyIssueGroup
> {
  private connection: { provider: IProjectProvider; currentUser: IAuthenticatedUser } | undefined;
  private connectionKey: string | undefined;
  private lastFolderPath: string | undefined;
  private milestoneTitles = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly syncEmitter = new vscode.EventEmitter<{
    sync: SyncState;
    folderPath: string | undefined;
  }>();
  /** Fires with the connection state after every tree load, for the status bar. */
  readonly onDidSync = this.syncEmitter.event;
  private readonly countEmitter = new vscode.EventEmitter<number>();
  /** Fires with the number of open issues assigned to the user after every load. */
  readonly onDidChangeAssignedCount = this.countEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Drops the cached connection and asks VS Code to re-render the tree
   * immediately — used after "Sign Out of GitLab" (#21), which otherwise
   * cleared the stored token without the sidebar ever noticing.
   */
  invalidateConnection(): void {
    this.connection = undefined;
    this.connectionKey = undefined;
    this.changeEmitter.fire();
  }

  /** The connection built by the last tree load, if any — never prompts or connects. */
  getEstablishedConnection():
    { provider: IProjectProvider; currentUser: IAuthenticatedUser } | undefined {
    return this.connection;
  }

  /** Re-renders the tree (re-resolving the repository) without dropping a still-valid connection. */
  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(element: MyIssueSummary | MyIssueGroup): vscode.TreeItem {
    if ("kind" in element) {
      const group = new vscode.TreeItem(
        `${describeGroup(element.status)} (${element.issues.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      // A stable id lets VS Code remember each group's collapsed state.
      group.id = `group:${element.status}`;
      group.contextValue = "issueGroup";
      group.iconPath = new vscode.ThemeIcon(
        element.status === "in-progress"
          ? "debug-start"
          : element.status === "blocked"
            ? "circle-slash"
            : "circle-large-outline",
      );
      return group;
    }
    const item = new vscode.TreeItem(
      `#${element.number} ${element.title}`,
      vscode.TreeItemCollapsibleState.None,
    );
    const milestoneTitle = element.milestoneId
      ? (this.milestoneTitles.get(element.milestoneId) ?? null)
      : null;
    const status = workStatusOf(element.labels);
    const priority = priorityOf(element.labels);
    item.id = element.id;
    item.description = buildIssueDescription(element, milestoneTitle, vscode.l10n.t);
    item.tooltip = new vscode.MarkdownString(
      buildIssueTooltip(element, milestoneTitle, vscode.l10n.t),
    );
    item.contextValue = "issue";
    item.iconPath = new vscode.ThemeIcon(
      status === "in-progress" ? "sync" : status === "blocked" ? "error" : "issues",
      priority ? new vscode.ThemeColor(PRIORITY_COLORS[priority.rank]) : undefined,
    );
    item.command = {
      command: "remoteProjectManager.openIssueFromTree",
      title: vscode.l10n.t("Open Issue"),
      arguments: [element.id],
    };
    return item;
  }

  async getChildren(
    element?: MyIssueSummary | MyIssueGroup,
  ): Promise<(MyIssueSummary | MyIssueGroup)[]> {
    if (element) {
      return "kind" in element ? element.issues : [];
    }
    let folderPath: string | undefined;
    try {
      this.syncEmitter.fire({ sync: { kind: "loading" }, folderPath: this.lastFolderPath });
      const connection = await this.getConnection();
      folderPath = this.lastFolderPath;
      if (!connection) {
        this.syncEmitter.fire({ sync: { kind: "unavailable" }, folderPath });
        return [];
      }
      const issues = await connection.provider.listIssues();
      this.syncEmitter.fire({
        sync: {
          kind: "ok",
          issues: issues.map(({ id, number, title }) => ({ id, number, title })),
        },
        folderPath,
      });
      const mine = selectMyOpenIssues(issues, connection.currentUser.username);
      this.countEmitter.fire(mine.length);
      await this.loadMilestoneTitles(connection.provider);
      return groupMyIssues(mine);
    } catch (error) {
      logger.warn(
        isAuthError(error) ? "Sidebar: authentication failed" : "Sidebar: could not load issues",
        error,
      );
      this.syncEmitter.fire({
        sync: { kind: isAuthError(error) ? "auth-error" : "unavailable" },
        folderPath: folderPath ?? this.lastFolderPath,
      });
      // Drop the cached connection on an auth failure (e.g. a revoked
      // GitLab token) so the next reveal re-runs getConnection() and
      // goes through resolveAndConnect's re-prompt flow, instead of
      // reusing a dead provider forever.
      if (isAuthError(error)) {
        this.connection = undefined;
      }
      return [];
    }
  }

  /** Milestone titles for the tree descriptions; best-effort, titles are a nicety. */
  private async loadMilestoneTitles(provider: IProjectProvider): Promise<void> {
    try {
      const milestones = await provider.listMilestones();
      this.milestoneTitles = new Map(
        milestones.map((milestone) => [milestone.id, milestone.title]),
      );
    } catch {
      this.milestoneTitles = new Map();
    }
  }

  private async getConnection(): Promise<
    { provider: IProjectProvider; currentUser: IAuthenticatedUser } | undefined
  > {
    // Re-resolve every time (cheap local `git remote get-url`) so a
    // connection never outlives the repository it was built for.
    const resolution = await resolveRepository();
    this.lastFolderPath = resolution.kind === "resolved" ? resolution.folderPath : undefined;
    const key = repositoryKey(resolution);
    if (this.connection && this.connectionKey === key) {
      return this.connection;
    }
    this.connection = undefined;
    this.connectionKey = undefined;
    if (resolution.kind !== "resolved") {
      return undefined;
    }
    this.connection = await connectRepository(
      this.context,
      resolution.providerKind,
      resolution.repository,
    );
    this.connectionKey = key;
    return this.connection;
  }
}

/**
 * Periodically refreshes the sidebar (and the open panel) so assigned
 * issues and the activity-bar badge stay current without a manual
 * Refresh. Polls only while the window is focused, catches up as soon as
 * focus returns, and goes through the normal TTL cache, so the interval
 * is also bounded below by `cacheTtlSeconds`.
 */
export function startAutoRefresh(treeDataProvider: MyIssuesTreeDataProvider): vscode.Disposable {
  let lastRunAt = Date.now();
  const tick = (): void => {
    const intervalSeconds = normalizePollInterval(
      vscode.workspace.getConfiguration("remoteProjectManager").get<number>("autoRefreshSeconds"),
    );
    const now = Date.now();
    if (
      !isPollDue({ intervalSeconds, windowFocused: vscode.window.state.focused, lastRunAt, now })
    ) {
      return;
    }
    lastRunAt = now;
    treeDataProvider.refresh();
    void state.activeController?.handleMessage({ type: "requestState" });
  };
  // Finer than any allowed interval, so a due poll is never late by much.
  const timer = setInterval(tick, 15_000);
  const focusListener = vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) {
      tick();
    }
  });
  return new vscode.Disposable(() => {
    clearInterval(timer);
    focusListener.dispose();
  });
}
