/**
 * Mutable state shared by the extension's modules: the open panel and its
 * connection, the remembered repository, and the sidebar provider. Kept in
 * one object so modules never import each other's `let` bindings.
 */
import type * as vscode from "vscode";
import type { ProviderKind } from "./core/models/issue.model";
import type { IProjectProvider } from "./core/providers/project-provider.interface";
import type { PanelController } from "./webview/panel-controller";
import type { MyIssuesTreeDataProvider } from "./tree-view";

export const state: {
  /** The remembered repository folder; used by {@link resolveRepository} when several folders qualify. */
  selectedRepositoryFolder: string | undefined;
  /** The sidebar provider, so a repository switch from the panel can refresh it. */
  activeTreeProvider: MyIssuesTreeDataProvider | undefined;
  /** The single open panel and its controller, if any — see {@link openPanel}. */
  activePanel: vscode.WebviewPanel | undefined;
  activeController: PanelController | undefined;
  /** The workspace folder, connected provider, and provider kind backing `activeController`, if any (see {@link buildController}). */
  activeFolderPath: string | undefined;
  activeProvider: IProjectProvider | undefined;
  activeProviderKind: ProviderKind | undefined;
  /** {@link repositoryKey} of the resolution `activePanel` was built from, to detect a repository switch. */
  activeRepositoryKey: string | undefined;
  /**
   * Opens the central panel, or reveals it if one is already open instead
   * of creating a duplicate editor tab and rebuilding the whole
   * provider/controller (with its own extra token resolution and API
   * calls). Pass `pendingAction` to also apply a deferred UI action (select
   * an issue, open a create form, or force-refresh) once a controller is
   * ready — used by the sidebar tree's click-through (#25) and the
   * Command Palette entries (#35).
   */
  /**
   * Serializes {@link openPanelImpl} calls: `activePanel`/`activeController`
   * aren't assigned until after an `await resolveRepository()` (and, on
   * the "resolved" path, an `await buildController()`), so two commands
   * that both call `openPanel` in quick succession (e.g. a fast
   * double-click on a sidebar tree item, or the Command Palette racing a
   * tree click) would otherwise both see no active panel yet and each
   * build their own — duplicate token prompts/API calls, and whichever
   * finishes last silently wins `activePanel`/`activeProvider`, leaving
   * them possibly out of sync with each other. A caller that arrives
   * while another call is in flight waits for it, then re-checks (via the
   * recursive call) instead of racing a second `buildController`.
   */
  openPanelInFlight: Promise<void> | undefined;
  /** The most recently copied issue context, exposed via this extension's API (see {@link activate}) for other extensions/agents. */
  lastIssueContext: string | undefined;
} = {
  selectedRepositoryFolder: undefined,
  activeTreeProvider: undefined,
  activePanel: undefined,
  activeController: undefined,
  activeFolderPath: undefined,
  activeProvider: undefined,
  activeProviderKind: undefined,
  activeRepositoryKey: undefined,
  openPanelInFlight: undefined,
  lastIssueContext: undefined,
};
