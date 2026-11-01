import * as vscode from "vscode";
import { SimpleGitService } from "./providers/git/simple-git.service";
import { buildStatusBarModel, type SyncState } from "./core/status/status-bar-model";

/**
 * Status bar item showing the issue the current branch maps to. It is fed
 * by the sidebar tree's sync snapshots (so it never triggers its own
 * connection or token prompt) and re-reads the branch whenever
 * `.git/HEAD` changes or the window regains focus.
 */
export class IssueStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly gitService = new SimpleGitService();
  private readonly disposables: vscode.Disposable[] = [this.item];
  private sync: SyncState = { kind: "unavailable" };
  private folderPath: string | undefined;
  private branch: string | null = null;
  private headWatcher: vscode.Disposable | undefined;

  constructor() {
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          void this.readBranchAndRender();
        }
      }),
      new vscode.Disposable(() => {
        this.headWatcher?.dispose();
      }),
    );
    this.render();
  }

  /** Called with each sync snapshot published by the sidebar tree. */
  update(sync: SyncState, folderPath: string | undefined): void {
    this.sync = sync;
    if (folderPath !== this.folderPath) {
      this.folderPath = folderPath;
      this.watchHead();
    }
    void this.readBranchAndRender();
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private watchHead(): void {
    this.headWatcher?.dispose();
    this.headWatcher = undefined;
    if (!this.folderPath) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.folderPath, ".git/HEAD"),
    );
    const refresh = (): void => {
      void this.readBranchAndRender();
    };
    this.headWatcher = vscode.Disposable.from(
      watcher,
      watcher.onDidChange(refresh),
      watcher.onDidCreate(refresh),
    );
  }

  private async readBranchAndRender(): Promise<void> {
    if (this.folderPath) {
      try {
        const current = await this.gitService.getCurrentBranch(this.folderPath);
        this.branch = current === "HEAD" ? null : current;
      } catch {
        this.branch = null;
      }
    } else {
      this.branch = null;
    }
    this.render();
  }

  private render(): void {
    const model = buildStatusBarModel(this.branch, this.sync, vscode.l10n.t);
    if (!model.visible) {
      this.item.hide();
      return;
    }
    this.item.text = model.text;
    this.item.tooltip = model.tooltip;
    this.item.command = {
      command: model.command,
      title: vscode.l10n.t("Open"),
      arguments: [...model.commandArguments],
    };
    this.item.backgroundColor =
      model.severity === "error"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : model.severity === "warning"
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
    this.item.show();
  }
}
