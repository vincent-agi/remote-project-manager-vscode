import type { CommitType } from "./commit-message";

const DOC_FILE = /(^|\/)(docs?\/|[^/]*\.(md|mdx|txt|rst)$)/i;
const TEST_FILE = /(^|\/)(tests?|__tests__|test-integration)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const CI_FILE = /^\.github\/|^\.gitlab-ci\.ya?ml$|^\.circleci\//i;
const BUILD_FILE =
  /^(package(-lock)?\.json|pnpm-lock\.ya?ml|yarn\.lock|tsconfig[^/]*\.json|\.vscodeignore|esbuild[^/]*|webpack[^/]*|vite[^/]*\.[cm]?[jt]s)$/i;

/** Directories that carry no meaning as a commit scope. */
const GENERIC_SEGMENTS: ReadonlySet<string> = new Set([
  "src",
  "test",
  "tests",
  "lib",
  "packages",
  "core",
]);

/** Maps a branch type prefix (`fix/53-x`, `feature/12`) to a commit type. */
const BRANCH_PREFIX_TYPES: Readonly<Record<string, CommitType>> = {
  fix: "fix",
  bugfix: "fix",
  hotfix: "fix",
  feat: "feat",
  feature: "feat",
  docs: "docs",
  doc: "docs",
  refactor: "refactor",
  perf: "perf",
  test: "test",
  tests: "test",
  ci: "ci",
  build: "build",
  chore: "chore",
};

function allMatch(files: readonly string[], pattern: RegExp): boolean {
  return files.every((file) => pattern.test(file));
}

/**
 * Suggests a Conventional Commits type from the staged file paths: a
 * change touching only docs, tests, CI or build files is classified as
 * such; anything else falls back to the branch's type prefix. Returns
 * `undefined` when nothing can be inferred (no files, or an unprefixed
 * branch with mixed source changes).
 */
export function suggestCommitType(
  stagedFiles: readonly string[],
  branchName?: string | null,
): CommitType | undefined {
  if (stagedFiles.length > 0) {
    if (allMatch(stagedFiles, DOC_FILE)) {
      return "docs";
    }
    if (allMatch(stagedFiles, TEST_FILE)) {
      return "test";
    }
    if (allMatch(stagedFiles, CI_FILE)) {
      return "ci";
    }
    if (allMatch(stagedFiles, BUILD_FILE)) {
      return "build";
    }
  }
  const prefix = branchName?.split("/", 2)[0]?.toLowerCase();
  return branchName?.includes("/") && prefix ? BRANCH_PREFIX_TYPES[prefix] : undefined;
}

function scopeOf(file: string): string | undefined {
  const directories = file.split("/").slice(0, -1);
  return directories.find((segment) => !GENERIC_SEGMENTS.has(segment));
}

/**
 * Suggests a scope: the first meaningful directory (skipping `src`,
 * `test`, `core`, ...) shared by every staged file. `undefined` when the
 * files span several areas or sit at the repository root.
 */
export function suggestCommitScope(stagedFiles: readonly string[]): string | undefined {
  if (stagedFiles.length === 0) {
    return undefined;
  }
  const scopes = new Set(stagedFiles.map(scopeOf));
  const [only] = scopes;
  return scopes.size === 1 ? only : undefined;
}
