import { wasNewlyAssignedToMe } from "../core/automation/assignment-change";
import { detectIssueTransition, type IssueTransition } from "../core/automation/issue-transition";
import type { IIssue } from "../core/models/issue.model";
import type {
  FetchOptions,
  IAuthenticatedUser,
  IProjectProvider,
} from "../core/providers/project-provider.interface";
import { assertCanWrite, hasFetchTimestamps } from "../core/providers/project-provider.interface";
import { isAuthError } from "../core/auth/is-auth-error";
import type { SettingEntry } from "../core/settings/settings-schema";
import type { InboundMessage, IssueTemplateView, OutboundMessage, UiPrefsView } from "./messages";

/** Called when an issue update crosses a recognized lifecycle transition. */
export type IssueTransitionHandler = (issue: IIssue, transition: IssueTransition) => void;

/** Called when a fetch reveals the current user was newly assigned to an issue. */
export type NewAssignmentHandler = (issue: IIssue) => void;

/**
 * Called when the webview asks to create (and switch to) a branch for an
 * issue. Resolves to a success message to toast, or `null` when the user
 * cancelled (e.g. backed out of the base-branch picker or the dirty-tree
 * prompt) and nothing should be shown. Throws to report a failure, which
 * `handleMessage`'s catch turns into an `error` message.
 */
export type CreateBranchRequestHandler = (issue: IIssue) => Promise<string | null>;

/** Persists the webview's UI preferences (backed by `workspaceState` in the extension host). */
export interface UiPrefsStore {
  get(): UiPrefsView;
  set(prefs: UiPrefsView): void | PromiseLike<void>;
}

/**
 * What the settings page needs from the host: the current settings, a way
 * to change one (resolving to an error text, or `null` on success; a `null`
 * value resets the setting), and the live branch-name preview.
 */
export interface SettingsBridge {
  read(): SettingEntry[];
  write(key: string, value: unknown): Promise<string | null>;
  previewBranchName(
    pattern: string,
    sample: { title: string; number: number; labels: readonly string[] },
  ): { example: string; warnings: string[] };
}

/**
 * Drives the central panel's state: fetches issues/milestones/capabilities
 * from an {@link IProjectProvider} and applies webview-initiated edits,
 * enforcing write permissions before any mutation. Framework-agnostic —
 * `postMessage` is the only side-effecting dependency, so this can be
 * unit tested without a real VS Code webview.
 *
 * `onIssueTransition` is the automation hook: it fires on recognized
 * lifecycle changes (e.g. an issue closing, or picking up the
 * "in-progress" label) so automation like auto-creating a branch can
 * subscribe without this class knowing about branches or git.
 * `onNewAssignment` is a parallel, independent hook: it fires whenever a
 * fetch reveals the current user was newly added to an issue's
 * assignees, regardless of any state/label transition on that issue.
 *
 * Transitions are detected by diffing each freshly fetched issue against
 * the *last state snapshot this controller sent*, not an immediate
 * before/after pair around a single edit. This matters: the panel's edit
 * form has no labels field, so the "in-progress" label is always added
 * externally (directly on GitHub/GitLab). Diffing against the last
 * snapshot means it fires on the next fetch — a manual Refresh, or the
 * `sendState()` after any other edit — instead of never firing at all.
 */
export class PanelController {
  private lastIssuesById: Map<string, IIssue> | null = null;
  private cachedUser: IAuthenticatedUser | null = null;

  constructor(
    private readonly provider: IProjectProvider,
    private readonly postMessage: (message: OutboundMessage) => void,
    private readonly onIssueTransition?: IssueTransitionHandler,
    private readonly onCreateBranchRequest?: CreateBranchRequestHandler,
    private readonly onNewAssignment?: NewAssignmentHandler,
    private readonly onError?: (error: unknown) => void,
    private readonly uiPrefsStore?: UiPrefsStore,
    private readonly onReconnectRequest?: () => void,
    private readonly loadIssueTemplates?: () => Promise<readonly IssueTemplateView[]>,
    private readonly settings?: SettingsBridge,
  ) {}

  async handleMessage(message: InboundMessage): Promise<void> {
    try {
      switch (message.type) {
        case "requestSettings":
          if (this.settings) {
            this.postMessage({ type: "settings", entries: this.settings.read() });
          }
          return;
        case "updateSetting": {
          if (!this.settings) {
            return;
          }
          const failure = await this.settings.write(message.key, message.value);
          if (failure) {
            this.postMessage({ type: "error", message: failure });
            return;
          }
          this.postMessage({ type: "actionSuccess", message: "Setting saved." });
          this.postMessage({ type: "settings", entries: this.settings.read() });
          return;
        }
        case "previewBranchName":
          if (this.settings) {
            this.postMessage({
              type: "branchNamePreview",
              pattern: message.pattern,
              ...this.settings.previewBranchName(message.pattern, message.sample),
            });
          }
          return;
        case "requestComments":
          this.postMessage({
            type: "comments",
            issueId: message.issueId,
            comments: await this.provider.listComments(message.issueId),
          });
          return;
        case "addComment": {
          const body = message.body.trim();
          if (!body) {
            this.postMessage({ type: "error", message: "A comment cannot be empty." });
            return;
          }
          await this.guardWrite("canWriteIssues");
          await this.provider.addComment(message.issueId, body);
          this.postMessage({ type: "actionSuccess", message: "Comment added." });
          this.postMessage({
            type: "comments",
            issueId: message.issueId,
            comments: await this.provider.listComments(message.issueId),
          });
          // The issue's comment count changed too.
          await this.sendState();
          return;
        }
        case "requestIssueTemplates":
          if (this.loadIssueTemplates) {
            this.postMessage({
              type: "issueTemplates",
              templates: await this.loadIssueTemplates().catch(() => []),
            });
          }
          return;
        case "reconnect":
          this.onReconnectRequest?.();
          return;
        case "saveUiPrefs":
          await this.uiPrefsStore?.set(message.prefs);
          return;
        case "requestState":
          if (this.uiPrefsStore) {
            this.postMessage({ type: "uiPrefs", prefs: this.uiPrefsStore.get() });
          }
          await this.sendState(message.forceRefresh ? { forceRefresh: true } : undefined);
          return;
        case "createIssue":
          await this.guardWrite("canWriteIssues");
          await this.provider.createIssue(message.input);
          this.postMessage({ type: "actionSuccess", message: "Issue created." });
          await this.sendState();
          return;
        case "updateIssue":
          await this.guardWrite("canWriteIssues");
          await this.provider.updateIssue(message.id, message.patch);
          this.postMessage({ type: "actionSuccess", message: "Issue updated." });
          await this.sendState();
          return;
        case "createMilestone":
          await this.guardWrite("canWriteMilestones");
          await this.provider.createMilestone(message.input);
          this.postMessage({ type: "actionSuccess", message: "Milestone created." });
          await this.sendState();
          return;
        case "updateMilestone":
          await this.guardWrite("canWriteMilestones");
          await this.provider.updateMilestone(message.id, message.patch);
          this.postMessage({ type: "actionSuccess", message: "Milestone updated." });
          await this.sendState();
          return;
        case "createBranchForIssue": {
          if (!this.onCreateBranchRequest) {
            return;
          }
          const issue = this.lastIssuesById?.get(message.id);
          if (!issue) {
            this.postMessage({ type: "error", message: "Issue not found." });
            return;
          }
          const successMessage = await this.onCreateBranchRequest(issue);
          if (successMessage) {
            this.postMessage({ type: "actionSuccess", message: successMessage });
          }
          return;
        }
      }
    } catch (error) {
      this.onError?.(error);
      this.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        ...(isAuthError(error) ? { authError: true } : {}),
      });
    }
  }

  private async guardWrite(permission: "canWriteIssues" | "canWriteMilestones"): Promise<void> {
    const capabilities = await this.provider.getCapabilities();
    assertCanWrite(capabilities, permission);
  }

  private detectAndNotifyTransitions(issues: readonly IIssue[], username: string): void {
    const previousById = this.lastIssuesById;
    this.lastIssuesById = new Map(issues.map((issue) => [issue.id, issue]));

    if (!previousById) {
      return;
    }

    for (const issue of issues) {
      const previous = previousById.get(issue.id);
      if (!previous) {
        continue;
      }
      if (this.onIssueTransition) {
        const transition = detectIssueTransition(previous, issue);
        if (transition !== "none") {
          this.onIssueTransition(issue, transition);
        }
      }
      if (this.onNewAssignment && wasNewlyAssignedToMe(previous, issue, username)) {
        this.onNewAssignment(issue);
      }
    }
  }

  /**
   * The authenticated user can't change mid-session, so fetch it once and
   * reuse it — matching ADR-0003's documented intent ("getCurrentUser is
   * called once per session"), which `sendState()` was violating by
   * calling it on every requestState/create/update.
   */
  private async getCurrentUser(): Promise<IAuthenticatedUser> {
    if (!this.cachedUser) {
      this.cachedUser = await this.provider.getCurrentUser();
    }
    return this.cachedUser;
  }

  private async sendState(options?: FetchOptions): Promise<void> {
    const [
      capabilities,
      issues,
      milestones,
      currentUser,
      availableLabels,
      availableAssignableUsers,
      labelColors,
    ] = await Promise.all([
      this.provider.getCapabilities(options),
      this.provider.listIssues(options),
      this.provider.listMilestones(options),
      this.getCurrentUser(),
      this.provider.listLabels(options),
      this.provider.listAssignableUsers(options),
      // Colours only decorate badges; never let them fail the whole state.
      this.provider.listLabelColors(options).catch((): Record<string, string> => ({})),
    ]);
    this.detectAndNotifyTransitions(issues, currentUser.username);
    this.postMessage({
      type: "state",
      issues,
      milestones,
      capabilities,
      currentUser,
      availableLabels,
      availableAssignableUsers,
      labelColors,
      ...(hasFetchTimestamps(this.provider) && this.provider.getIssuesFetchedAt() !== undefined
        ? { dataFetchedAt: this.provider.getIssuesFetchedAt() }
        : {}),
    });
  }
}
