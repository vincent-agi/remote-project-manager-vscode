import type { IIssue, ProviderKind } from "../core/models/issue.model";
import type { IMilestone } from "../core/models/milestone.model";
import type {
  CreateIssueInput,
  CreateMilestoneInput,
  IAuthenticatedUser,
  ProviderCapabilities,
  UpdateIssueInput,
  UpdateMilestoneInput,
} from "../core/providers/project-provider.interface";

/** One workspace folder's repository, offered in the multi-root picker. */
export interface RepositoryOptionView {
  readonly id: string;
  readonly label: string;
  readonly provider: ProviderKind;
  readonly repository: string;
}

/**
 * Per-workspace UI preferences (saved filters, sort order, ...). Opaque to
 * the host: the webview owns the shape and validates what it reads back.
 */
export type UiPrefsView = Readonly<Record<string, unknown>>;

/** An issue template offered in the new-issue form. */
export interface IssueTemplateView {
  readonly name: string;
  readonly body: string;
  readonly title?: string;
  readonly labels: readonly string[];
}

/** Messages the webview sends to the extension host. */
export type InboundMessage =
  | { readonly type: "requestState"; readonly forceRefresh?: boolean }
  | { readonly type: "selectRepository"; readonly id: string }
  | { readonly type: "updateIssue"; readonly id: string; readonly patch: UpdateIssueInput }
  | { readonly type: "createIssue"; readonly input: CreateIssueInput }
  | { readonly type: "updateMilestone"; readonly id: string; readonly patch: UpdateMilestoneInput }
  | { readonly type: "createMilestone"; readonly input: CreateMilestoneInput }
  | { readonly type: "createBranchForIssue"; readonly id: string }
  | { readonly type: "saveUiPrefs"; readonly prefs: UiPrefsView }
  | { readonly type: "reconnect" }
  | { readonly type: "requestIssueTemplates" };

/** Messages the extension host sends to the webview. */
export type OutboundMessage =
  | {
      readonly type: "state";
      readonly issues: readonly IIssue[];
      readonly milestones: readonly IMilestone[];
      readonly capabilities: ProviderCapabilities;
      readonly currentUser: IAuthenticatedUser;
      readonly availableLabels: readonly string[];
      readonly availableAssignableUsers: readonly string[];
      /** Epoch ms the issue list was last fetched from the remote, when known. */
      readonly dataFetchedAt?: number;
    }
  | { readonly type: "uiPrefs"; readonly prefs: UiPrefsView }
  | { readonly type: "issueTemplates"; readonly templates: readonly IssueTemplateView[] }
  | { readonly type: "repositoryOptions"; readonly options: readonly RepositoryOptionView[] }
  | { readonly type: "selectIssue"; readonly id: string }
  | { readonly type: "openNewIssueForm" }
  | { readonly type: "openNewMilestoneForm" }
  | { readonly type: "actionSuccess"; readonly message: string }
  | { readonly type: "error"; readonly message: string; readonly authError?: boolean };
