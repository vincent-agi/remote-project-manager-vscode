import * as vscode from "vscode";
import { SimpleGitService } from "./providers/git/simple-git.service";
import { extractIssueNumberFromBranch } from "./core/git/branch-issue-ref";
import {
  decideCommitSync,
  findIssuesClosedByCommits,
  labelsWithInProgress,
} from "./core/automation/state-sync";
import type {
  IProjectProvider,
  IAuthenticatedUser,
} from "./core/providers/project-provider.interface";
import { logger } from "./logger";

const DISMISSED_REMINDERS_KEY = "remoteProjectManager.dismissedBranchReminders";
/** How many default-branch commits are scanned for closing keywords. */
const MERGED_SCAN_LIMIT = 200;

export interface StateSyncConnection {
  readonly provider: IProjectProvider;
  readonly currentUser: IAuthenticatedUser;
}

/**
 * Keeps issue state in step with git activity (#87). It only ever uses a
 * connection that already exists (never prompting for a token from the
 * background), and each automation can be switched off in settings:
 *
 * - first commit on an issue's branch: the issue gains "in-progress";
 * - a commit on a branch that maps to no issue: a one-off reminder;
 * - default-branch commits that already close a still-open issue: a prompt
 *   to close it (never closes silently).
 */
export class StateSync implements vscode.Disposable {
  private readonly gitService = new SimpleGitService();
  private readonly proposedClosures = new Set<number>();
  private readonly reminded = new Set<string>();
  private readonly markedInProgress = new Set<number>();
  private watcher: vscode.Disposable | undefined;
  private folderPath: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getConnection: () => StateSyncConnection | undefined,
    private readonly refreshTree: () => void,
  ) {}

  /** Called after each successful sidebar sync: (re)watches the repository and scans for merged work. */
  onSynced(folderPath: string | undefined): void {
    if (folderPath !== this.folderPath) {
      this.folderPath = folderPath;
      this.watch();
    }
    void this.proposeClosures();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.watcher?.dispose();
  }

  private flag(name: string): boolean {
    return vscode.workspace.getConfiguration("remoteProjectManager").get<boolean>(name, true);
  }

  private watch(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    if (!this.folderPath) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.folderPath, ".git/logs/HEAD"),
    );
    const schedule = (): void => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.onHeadMoved();
      }, 1000);
    };
    this.watcher = vscode.Disposable.from(
      watcher,
      watcher.onDidChange(schedule),
      watcher.onDidCreate(schedule),
    );
  }

  private async onHeadMoved(): Promise<void> {
    const cwd = this.folderPath;
    const connection = this.getConnection();
    const wantsInProgress = this.flag("syncMarkInProgressOnCommit");
    const wantsReminder = this.flag("syncRemindMissingIssue");
    if (!cwd || !connection || (!wantsInProgress && !wantsReminder)) {
      return;
    }
    try {
      // Only react to commits, not to checkouts, merges or rebases.
      if (!(await this.gitService.getLastReflogSubject(cwd)).startsWith("commit")) {
        return;
      }
      const [branch, defaultBranch] = await Promise.all([
        this.gitService.getCurrentBranch(cwd),
        this.gitService.getDefaultBranch(cwd),
      ]);
      const ahead = await this.gitService.log(cwd, `origin/${defaultBranch}..HEAD`);
      const action = decideCommitSync({
        branch,
        defaultBranch,
        commitsAhead: ahead.length,
        branchIssueNumber: extractIssueNumberFromBranch(branch),
        issues: await connection.provider.listIssues(),
        username: connection.currentUser.username,
      });
      if (action.kind === "mark-in-progress" && wantsInProgress) {
        await this.markInProgress(connection.provider, action.issue);
      } else if (action.kind === "remind-no-issue" && wantsReminder) {
        await this.remindNoIssue(action.branch);
      }
    } catch (error) {
      logger.warn("State sync: could not process the latest commit", error);
    }
  }

  private async markInProgress(
    provider: IProjectProvider,
    issue: Parameters<typeof labelsWithInProgress>[0],
  ): Promise<void> {
    if (this.markedInProgress.has(issue.number)) {
      return;
    }
    this.markedInProgress.add(issue.number);
    const capabilities = await provider.getCapabilities();
    if (!capabilities.canWriteIssues) {
      logger.info(`State sync: no write access, #${issue.number} not marked in-progress`);
      return;
    }
    await provider.updateIssue(issue.id, { labels: labelsWithInProgress(issue) });
    logger.info(`State sync: #${issue.number} marked in-progress`);
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Issue #{0} marked "in-progress" after your first commit.', issue.number),
    );
    this.refreshTree();
  }

  private async remindNoIssue(branch: string): Promise<void> {
    const dismissed = this.context.workspaceState.get<string[]>(DISMISSED_REMINDERS_KEY, []);
    if (dismissed.includes(branch) || this.reminded.has(branch)) {
      return;
    }
    this.reminded.add(branch);
    const newIssueLabel = vscode.l10n.t("New Issue");
    const dismissLabel = vscode.l10n.t("Don't remind for this branch");
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t("Branch '{0}' is not linked to an issue.", branch),
      newIssueLabel,
      dismissLabel,
    );
    if (choice === newIssueLabel) {
      await vscode.commands.executeCommand("remoteProjectManager.newIssue");
    } else if (choice === dismissLabel) {
      await this.context.workspaceState.update(DISMISSED_REMINDERS_KEY, [...dismissed, branch]);
    }
  }

  private async proposeClosures(): Promise<void> {
    const cwd = this.folderPath;
    const connection = this.getConnection();
    if (!cwd || !connection || !this.flag("syncProposeCloseOnMerge")) {
      return;
    }
    try {
      const defaultBranch = await this.gitService.getDefaultBranch(cwd);
      const commits = await this.gitService.log(cwd, `origin/${defaultBranch}`, MERGED_SCAN_LIMIT);
      const issues = await connection.provider.listIssues();
      const mine = issues.filter((issue) =>
        issue.assignees.some(
          (assignee) => assignee.toLowerCase() === connection.currentUser.username.toLowerCase(),
        ),
      );
      const closable = findIssuesClosedByCommits(
        mine,
        commits.map((commit) => commit.message),
      ).filter((issue) => !this.proposedClosures.has(issue.number));
      for (const issue of closable) {
        this.proposedClosures.add(issue.number);
        const closeLabel = vscode.l10n.t("Close issue");
        const choice = await vscode.window.showInformationMessage(
          vscode.l10n.t(
            "Issue #{0} is still open but was closed by a commit on '{1}'. Close it?",
            issue.number,
            defaultBranch,
          ),
          closeLabel,
        );
        if (choice === closeLabel) {
          await connection.provider.updateIssue(issue.id, { state: "closed" });
          logger.info(`State sync: #${issue.number} closed`);
          this.refreshTree();
        }
      }
    } catch (error) {
      logger.warn("State sync: could not check for merged work", error);
    }
  }
}
