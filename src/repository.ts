/** Which repository the extension works with: detection from the workspace, the remembered choice, switching, and keeping the UI in sync with the loaded repository. */
import * as vscode from "vscode";
import type { ProviderKind } from "./core/models/issue.model";
import { SimpleGitService } from "./providers/git/simple-git.service";
import {
  chooseRepository,
  repositoryKey,
  resolveRepositoryCandidates,
  type RepositoryCandidate,
  type RepositoryResolution,
} from "./core/workspace/repository-resolver";
import type { RepositoryOptionView } from "./webview/messages";
import { logger } from "./logger";
import { openPanel } from "./panel";
import type { MyIssuesTreeDataProvider } from "./tree-view";
import { state } from "./state";

/**
 * Resolves which repository to connect to: every workspace folder's
 * `origin` remote is inspected first (see ADR-0003 and ADR-0007), and the
 * `remoteProjectManager.repository` setting is only a fallback when none
 * is recognized — so the issues shown always match the loaded code.
 * Returns a single resolved repository, or a list of candidates for the
 * webview picker when more than one workspace folder matches.
 */
/** `workspaceState` key remembering which workspace folder's repository the user picked. */
export const SELECTED_REPOSITORY_KEY = "remoteProjectManager.selectedRepositoryFolder";

export async function resolveRepository(): Promise<RepositoryResolution> {
  const config = vscode.workspace.getConfiguration("remoteProjectManager");
  const providerKindSetting = config.get<ProviderKind>("provider", "github");
  const repositorySetting = config.get<string>("repository", "");
  const gitlabHost = config.get<string>("gitlabHost", "") || undefined;
  const giteaHost = config.get<string>("giteaHost", "") || undefined;

  const gitService = new SimpleGitService();
  const folders = vscode.workspace.workspaceFolders ?? [];
  const remotes = await Promise.all(
    folders.map(async (folder) => ({
      folderPath: folder.uri.fsPath,
      folderName: folder.name,
      remoteUrl: await gitService.getRemoteUrl(folder.uri.fsPath),
    })),
  );
  return chooseRepository(resolveRepositoryCandidates(remotes, gitlabHost, giteaHost), {
    provider: providerKindSetting,
    repository: repositorySetting,
    fallbackFolderPath: folders[0]?.uri.fsPath,
    preferredFolderPath: state.selectedRepositoryFolder,
  });
}

export function toRepositoryOptionView(candidate: RepositoryCandidate): RepositoryOptionView {
  return {
    id: candidate.folderPath,
    label: `${candidate.folderName} — ${candidate.provider}:${candidate.repository}`,
    provider: candidate.provider,
    repository: candidate.repository,
  };
}

/** Sets the `remoteProjectManager.multiRepo` context key that shows the sidebar's repository switcher. */
async function updateMultiRepositoryContext(): Promise<void> {
  const resolution = await resolveRepository();
  const multiple =
    resolution.kind === "candidates" ||
    (resolution.kind === "resolved" && (resolution.alternatives?.length ?? 0) > 1);
  await vscode.commands.executeCommand("setContext", "remoteProjectManager.multiRepo", multiple);
}

/** Remembers `folderPath` as the repository to use when several workspace folders qualify. */
export async function rememberRepository(
  context: vscode.ExtensionContext,
  folderPath: string,
): Promise<void> {
  state.selectedRepositoryFolder = folderPath;
  await context.workspaceState.update(SELECTED_REPOSITORY_KEY, folderPath);
}

/**
 * Switches the whole extension (sidebar, status bar, panel, commands) to
 * another workspace repository and remembers the choice.
 */
export async function switchRepository(
  context: vscode.ExtensionContext,
  folderPath: string,
): Promise<void> {
  await rememberRepository(context, folderPath);
  state.activeTreeProvider?.invalidateConnection();
  if (state.activeTreeProvider) {
    await syncWithRepository(context, state.activeTreeProvider);
  }
}

/** "Select Repository" command: pick among the workspace folders' repositories. */
export async function selectRepository(context: vscode.ExtensionContext): Promise<void> {
  const resolution = await resolveRepository();
  const options =
    resolution.kind === "candidates"
      ? resolution.candidates
      : resolution.kind === "resolved"
        ? (resolution.alternatives ?? [])
        : [];
  if (options.length < 2) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t("This workspace has only one repository."),
    );
    return;
  }
  const currentFolder = resolution.kind === "resolved" ? resolution.folderPath : undefined;
  const picked = await vscode.window.showQuickPick(
    options.map((candidate) => ({
      label: candidate.folderName,
      description: `${candidate.provider}:${candidate.repository}`,
      detail:
        candidate.folderPath === currentFolder ? vscode.l10n.t("Current repository") : undefined,
      candidate,
    })),
    { title: vscode.l10n.t("Select the repository to work with") },
  );
  if (picked) {
    await switchRepository(context, picked.candidate.folderPath);
  }
}

/**
 * Keeps the sidebar and the open panel in sync with the loaded git
 * repository. Re-resolves the repository and, when it differs from what
 * the open panel was built for, rebuilds the panel (re-running the
 * normal resolve/pick flow) so issues and milestones always belong to
 * the code currently open.
 */
export async function syncWithRepository(
  context: vscode.ExtensionContext,
  treeDataProvider: MyIssuesTreeDataProvider,
): Promise<void> {
  logger.info("Re-syncing with the loaded repository");
  treeDataProvider.refresh();
  void updateMultiRepositoryContext();
  if (!state.activePanel || state.openPanelInFlight) {
    return;
  }
  const key = repositoryKey(await resolveRepository());
  if (!state.activePanel || key === state.activeRepositoryKey) {
    return;
  }
  state.activePanel.dispose();
  await openPanel(context);
}

/** Debounces bursts of change events (e.g. several `.git/config` writes) into one sync. */
export function registerRepositorySync(
  context: vscode.ExtensionContext,
  treeDataProvider: MyIssuesTreeDataProvider,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void syncWithRepository(context, treeDataProvider);
    }, 300);
  };

  const watchers = new Map<string, vscode.Disposable>();
  const watchGitConfigs = (): void => {
    const current = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const folderPath = folder.uri.fsPath;
      current.add(folderPath);
      if (watchers.has(folderPath)) {
        continue;
      }
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, ".git/config"),
      );
      watchers.set(
        folderPath,
        vscode.Disposable.from(
          watcher,
          watcher.onDidChange(schedule),
          watcher.onDidCreate(schedule),
          watcher.onDidDelete(schedule),
        ),
      );
    }
    for (const [folderPath, disposable] of watchers) {
      if (!current.has(folderPath)) {
        disposable.dispose();
        watchers.delete(folderPath);
      }
    }
  };
  watchGitConfigs();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      watchGitConfigs();
      schedule();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("remoteProjectManager.repository") ||
        event.affectsConfiguration("remoteProjectManager.provider") ||
        event.affectsConfiguration("remoteProjectManager.gitlabHost") ||
        event.affectsConfiguration("remoteProjectManager.giteaHost")
      ) {
        schedule();
      }
    }),
    new vscode.Disposable(() => {
      clearTimeout(timer);
      for (const disposable of watchers.values()) {
        disposable.dispose();
      }
      watchers.clear();
    }),
  );
}
