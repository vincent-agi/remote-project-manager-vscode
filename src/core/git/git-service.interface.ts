/** Result of checking a working tree for uncommitted changes. */
export interface GitStatusSummary {
  /** True if there are any staged, unstaged, or untracked changes. */
  readonly isDirty: boolean;
}

/** A single commit as read from `git log`. */
export interface GitLogEntry {
  readonly hash: string;
  /** Full commit message (subject + body), trailers included. */
  readonly message: string;
}

/** A commit with the topology and decoration the graph view needs. */
export interface GitGraphCommit {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly author: string;
  /** Author date, ISO 8601. */
  readonly date: string;
  /** Branch/tag names pointing at this commit (e.g. `main`, `origin/main`, `v1.0`). */
  readonly refs: readonly string[];
  /** Full commit message (subject + body). */
  readonly message: string;
}

/**
 * Abstract contract for the git operations this extension needs:
 * detecting a repository's remote (for multi-root workspace resolution)
 * and, for V2, safely creating a branch for an issue. Decoupled from any
 * specific execution mechanism (CLI, `simple-git`, ...) so branch
 * creation logic can be unit tested against a fake.
 */
export interface IGitService {
  /** Returns the URL of `remoteName` ("origin" by default), or null if unset. */
  getRemoteUrl(cwd: string, remoteName?: string): Promise<string | null>;

  /** Reports whether the working tree has uncommitted changes. */
  getStatus(cwd: string): Promise<GitStatusSummary>;

  /** Fetches updates for `remoteName` ("origin" by default). */
  fetch(cwd: string, remoteName?: string): Promise<void>;

  /** Stashes uncommitted changes, including untracked files. */
  stash(cwd: string, message?: string): Promise<void>;

  /** Resolves the repository's default branch (e.g. "main", "master"). */
  getDefaultBranch(cwd: string): Promise<string>;

  /** Lists `remoteName`'s branches ("origin" by default), names only, without the remote prefix. */
  listBranches(cwd: string, remoteName?: string): Promise<string[]>;

  /** Creates and checks out `branchName`, based on `baseBranch`. */
  checkoutNewBranch(cwd: string, branchName: string, baseBranch: string): Promise<void>;

  /** Validates `branchName` against git's ref-name rules. */
  isValidBranchName(branchName: string): Promise<boolean>;

  /** Lists the paths staged for the next commit, relative to the repository root. */
  getStagedFiles(cwd: string): Promise<string[]>;

  /** Returns the currently checked-out branch name. */
  getCurrentBranch(cwd: string): Promise<string>;

  /**
   * Lists commits reachable from `range` (a git revision range, e.g.
   * `"origin/main..HEAD"`), most recent first. Defaults to `HEAD` alone
   * when `range` is omitted. `maxCount` caps the number of commits read.
   */
  log(cwd: string, range?: string, maxCount?: number): Promise<GitLogEntry[]>;

  /**
   * Reads up to `maxCount` commits across all branches in topological order
   * (children before parents), with parents, author, date and ref decorations.
   */
  getGraphLog(cwd: string, maxCount: number): Promise<GitGraphCommit[]>;

  /** The commit's diff as a unified patch (`git show`), for viewing when no diff UI is available. */
  getCommitPatch(cwd: string, hash: string): Promise<string>;

  /** Full SHA of the commit `HEAD` points to. */
  getHeadSha(cwd: string): Promise<string>;

  /** Absolute path of the repository's top-level directory. */
  getRepoRoot(cwd: string): Promise<string>;

  /** Subject of the latest reflog entry for HEAD (e.g. `"commit: feat: ..."`, `"checkout: moving ..."`). */
  getLastReflogSubject(cwd: string): Promise<string>;
}
