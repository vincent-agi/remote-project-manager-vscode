import * as path from "node:path";
import simpleGit from "simple-git";
import type {
  GitLogEntry,
  GitStatusSummary,
  IGitService,
} from "../../core/git/git-service.interface";
import { parseSymbolicRefBranch } from "../../core/git/parse-symbolic-ref";

const LOG_FIELD_SEP = "\x1f";
const LOG_RECORD_SEP = "\x1e";

const DEFAULT_BRANCH_CANDIDATES = ["main", "master", "devel"];

/**
 * {@link IGitService} implemented on top of `simple-git`, which shells
 * out to the real `git` binary. This is a thin adapter over an external
 * process, like the VS Code SecretStorage/webview adapters elsewhere in
 * the codebase (see ADR-0001): not unit tested here, since there is
 * nothing to test but simple-git's own behavior. `BranchManager`, which
 * contains the actual decision logic, is tested against a fake
 * {@link IGitService} instead.
 */
export class SimpleGitService implements IGitService {
  async getRemoteUrl(cwd: string, remoteName = "origin"): Promise<string | null> {
    try {
      const url = await simpleGit(cwd).raw(["remote", "get-url", remoteName]);
      return url.trim() || null;
    } catch {
      return null;
    }
  }

  async getStatus(cwd: string): Promise<GitStatusSummary> {
    const status = await simpleGit(cwd).status();
    return { isDirty: !status.isClean() };
  }

  async fetch(cwd: string, remoteName = "origin"): Promise<void> {
    await simpleGit(cwd).fetch(remoteName);
  }

  async stash(cwd: string, message = "remote-project-manager: auto-stash"): Promise<void> {
    await simpleGit(cwd).stash(["push", "-u", "-m", message]);
  }

  async getDefaultBranch(cwd: string): Promise<string> {
    const git = simpleGit(cwd);
    try {
      const ref = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
      const branch = parseSymbolicRefBranch(ref);
      if (branch) {
        return branch;
      }
    } catch {
      // Fall through to the candidate list below.
    }

    for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
      try {
        await git.raw(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
        return candidate;
      } catch {
        continue;
      }
    }

    throw new Error("Could not determine the default branch (tried main, master, devel).");
  }

  async listBranches(cwd: string, remoteName = "origin"): Promise<string[]> {
    const raw = await simpleGit(cwd).raw(["branch", "-r", "--format=%(refname:short)"]);
    const prefix = `${remoteName}/`;
    const names = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(prefix) && line !== `${prefix}HEAD`)
      .map((line) => line.slice(prefix.length));
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  }

  async checkoutNewBranch(cwd: string, branchName: string, baseBranch: string): Promise<void> {
    await simpleGit(cwd).checkoutBranch(branchName, `origin/${baseBranch}`);
  }

  async isValidBranchName(branchName: string): Promise<boolean> {
    try {
      await simpleGit().raw(["check-ref-format", "--branch", branchName]);
      return true;
    } catch {
      return false;
    }
  }

  /** Absolute path of the hooks directory, honouring `core.hooksPath` and worktrees. */
  async getHooksPath(cwd: string): Promise<string> {
    const raw = await simpleGit(cwd).raw(["rev-parse", "--git-path", "hooks"]);
    const hooksPath = raw.trim();
    return path.isAbsolute(hooksPath) ? hooksPath : path.join(cwd, hooksPath);
  }

  async getStagedFiles(cwd: string): Promise<string[]> {
    const raw = await simpleGit(cwd).raw(["diff", "--cached", "--name-only"]);
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  }

  async getCurrentBranch(cwd: string): Promise<string> {
    const branch = await simpleGit(cwd).raw(["rev-parse", "--abbrev-ref", "HEAD"]);
    return branch.trim();
  }

  async getLastReflogSubject(cwd: string): Promise<string> {
    const raw = await simpleGit(cwd).raw(["reflog", "-1", "--format=%gs"]);
    return raw.trim();
  }

  async log(cwd: string, range?: string, maxCount?: number): Promise<GitLogEntry[]> {
    const raw = await simpleGit(cwd).raw([
      "log",
      `--pretty=format:%H${LOG_FIELD_SEP}%B${LOG_RECORD_SEP}`,
      ...(maxCount ? [`--max-count=${maxCount}`] : []),
      ...(range ? [range] : []),
    ]);
    return raw
      .split(LOG_RECORD_SEP)
      .map((record) => record.replace(/^\n/, ""))
      .filter((record) => record.trim().length > 0)
      .map((record) => {
        const separatorIndex = record.indexOf(LOG_FIELD_SEP);
        return {
          hash: record.slice(0, separatorIndex),
          message: record.slice(separatorIndex + 1).replace(/\n+$/, ""),
        };
      });
  }
}
