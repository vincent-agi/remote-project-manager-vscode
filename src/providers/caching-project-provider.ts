import { TtlCache } from "../core/cache/ttl-cache";
import type { IIssue } from "../core/models/issue.model";
import type { IMilestone } from "../core/models/milestone.model";
import type {
  CreateIssueInput,
  CreateMilestoneInput,
  FetchOptions,
  IAuthenticatedUser,
  IFetchTimestamps,
  IProjectProvider,
  ProviderCapabilities,
  UpdateIssueInput,
  UpdateMilestoneInput,
} from "../core/providers/project-provider.interface";

const ISSUES_KEY = "issues";
const MILESTONES_KEY = "milestones";
const CAPABILITIES_KEY = "capabilities";
const LABELS_KEY = "labels";
const ASSIGNABLE_USERS_KEY = "assignableUsers";

/**
 * Decorates any {@link IProjectProvider} with a short TTL cache over its
 * list-style reads (issues, milestones, capabilities), to keep the
 * webview responsive without hitting GitHub/GitLab's rate limits on
 * every focus/poll. Single-item reads (`getIssue`, `getMilestone`,
 * `getCurrentUser`) pass straight through, since they are used right
 * before a write and must reflect the latest remote state.
 *
 * Any write invalidates every cached list, so the next read after an
 * edit is never stale — trading one extra network round trip for
 * correctness, which matters more than the cache hit rate here.
 */
export class CachingProjectProvider implements IProjectProvider, IFetchTimestamps {
  private readonly cache: TtlCache<unknown>;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private issuesFetchedAt: number | undefined;

  constructor(
    private readonly inner: IProjectProvider,
    ttlMs: number,
  ) {
    this.cache = new TtlCache(ttlMs);
  }

  /**
   * Serves `key` from cache when fresh, otherwise calls `fetcher` — but
   * two calls for the same key that overlap in time share a single
   * in-flight fetch instead of each issuing their own request, so a
   * near-simultaneous double-click (or an edit's own refetch racing an
   * unrelated read) doesn't cost the API twice.
   */
  private async cached<T>(
    key: string,
    options: FetchOptions | undefined,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    if (!options?.forceRefresh) {
      const hit = this.cache.get(key) as T | undefined;
      if (hit !== undefined) {
        return hit;
      }
    }
    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) {
      return pending;
    }
    const promise = fetcher()
      .then((value) => {
        this.cache.set(key, value);
        if (key === ISSUES_KEY) {
          this.issuesFetchedAt = Date.now();
        }
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  getIssuesFetchedAt(): number | undefined {
    return this.issuesFetchedAt;
  }

  getCurrentUser(): Promise<IAuthenticatedUser> {
    return this.inner.getCurrentUser();
  }

  getCapabilities(options?: FetchOptions): Promise<ProviderCapabilities> {
    return this.cached(CAPABILITIES_KEY, options, () => this.inner.getCapabilities());
  }

  listIssues(options?: FetchOptions): Promise<readonly IIssue[]> {
    return this.cached(ISSUES_KEY, options, () => this.inner.listIssues());
  }

  getIssue(id: string): Promise<IIssue> {
    return this.inner.getIssue(id);
  }

  async createIssue(input: CreateIssueInput): Promise<IIssue> {
    const result = await this.inner.createIssue(input);
    this.cache.invalidate(ISSUES_KEY);
    return result;
  }

  async updateIssue(id: string, patch: UpdateIssueInput): Promise<IIssue> {
    const result = await this.inner.updateIssue(id, patch);
    this.cache.invalidate(ISSUES_KEY);
    return result;
  }

  listMilestones(options?: FetchOptions): Promise<readonly IMilestone[]> {
    return this.cached(MILESTONES_KEY, options, () => this.inner.listMilestones());
  }

  getMilestone(id: string): Promise<IMilestone> {
    return this.inner.getMilestone(id);
  }

  async createMilestone(input: CreateMilestoneInput): Promise<IMilestone> {
    const result = await this.inner.createMilestone(input);
    this.cache.invalidate(MILESTONES_KEY);
    return result;
  }

  async updateMilestone(id: string, patch: UpdateMilestoneInput): Promise<IMilestone> {
    const result = await this.inner.updateMilestone(id, patch);
    this.cache.invalidate(MILESTONES_KEY);
    return result;
  }

  listLabels(options?: FetchOptions): Promise<readonly string[]> {
    return this.cached(LABELS_KEY, options, () => this.inner.listLabels());
  }

  listAssignableUsers(options?: FetchOptions): Promise<readonly string[]> {
    return this.cached(ASSIGNABLE_USERS_KEY, options, () => this.inner.listAssignableUsers());
  }
}
