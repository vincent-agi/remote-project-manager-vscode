import type { IIssue, IssueState } from "../models/issue.model";
import type { IMilestone, MilestoneState } from "../models/milestone.model";

/**
 * What the currently authenticated account is allowed to do on a
 * provider, as reported by that provider's permission model.
 */
export interface ProviderCapabilities {
  readonly canReadIssues: boolean;
  readonly canWriteIssues: boolean;
  readonly canReadMilestones: boolean;
  readonly canWriteMilestones: boolean;
}

/** Fields accepted when creating a new issue. */
export interface CreateIssueInput {
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly milestoneId?: string | null;
}

/** Partial update applied to an existing issue. */
export interface UpdateIssueInput {
  readonly title?: string;
  readonly body?: string;
  readonly state?: IssueState;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly milestoneId?: string | null;
}

/** Fields accepted when creating a new milestone. */
export interface CreateMilestoneInput {
  readonly title: string;
  readonly description?: string;
  readonly dueOn?: string | null;
}

/** Partial update applied to an existing milestone. */
export interface UpdateMilestoneInput {
  readonly title?: string;
  readonly description?: string;
  readonly state?: MilestoneState;
  readonly dueOn?: string | null;
}

/** The account currently authenticated against a provider. */
export interface IAuthenticatedUser {
  /** Login/username as used in issue `assignees` for this provider. */
  readonly username: string;
}

/**
 * Options accepted by read operations. `forceRefresh` tells a caching
 * decorator (e.g. `CachingProjectProvider`) to bypass its TTL cache and
 * hit the remote API, used for the webview's manual "Refresh" action.
 */
export interface FetchOptions {
  readonly forceRefresh?: boolean;
}

/**
 * Abstract contract every remote project management provider (GitHub,
 * GitLab, ...) must implement. UI and application code depend only on
 * this interface, never on a concrete provider.
 */
export interface IProjectProvider {
  /** Permissions the active account currently has on this provider. */
  getCapabilities(options?: FetchOptions): Promise<ProviderCapabilities>;

  /** The account the current token/session belongs to. */
  getCurrentUser(): Promise<IAuthenticatedUser>;

  listIssues(options?: FetchOptions): Promise<readonly IIssue[]>;
  getIssue(id: string): Promise<IIssue>;
  createIssue(input: CreateIssueInput): Promise<IIssue>;
  updateIssue(id: string, patch: UpdateIssueInput): Promise<IIssue>;

  listMilestones(options?: FetchOptions): Promise<readonly IMilestone[]>;
  getMilestone(id: string): Promise<IMilestone>;
  createMilestone(input: CreateMilestoneInput): Promise<IMilestone>;
  updateMilestone(id: string, patch: UpdateMilestoneInput): Promise<IMilestone>;

  /** Label names available on this repository, for a labels picker. */
  listLabels(options?: FetchOptions): Promise<readonly string[]>;

  /** Usernames that can be assigned to an issue on this repository. */
  listAssignableUsers(options?: FetchOptions): Promise<readonly string[]>;
}

/**
 * Guards a write operation against the account's reported capabilities.
 *
 * @param capabilities - Capabilities previously fetched from the provider.
 * @param permission - The specific write permission required.
 * @throws {Error} If the account does not have the required permission.
 */
export function assertCanWrite(
  capabilities: ProviderCapabilities,
  permission: "canWriteIssues" | "canWriteMilestones",
): void {
  if (!capabilities[permission]) {
    throw new Error(`Operation requires '${permission}', but the active account does not have it.`);
  }
}

/**
 * Optional capability of a caching provider: when the issue list it hands
 * out was last fetched from the remote (epoch ms), so the UI can say how
 * stale cached data is.
 */
export interface IFetchTimestamps {
  getIssuesFetchedAt(): number | undefined;
}

/** True when `provider` can report how old its cached issue list is. */
export function hasFetchTimestamps(provider: object): provider is IFetchTimestamps {
  return typeof (provider as Partial<IFetchTimestamps>).getIssuesFetchedAt === "function";
}
