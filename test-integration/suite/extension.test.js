// Real end-to-end coverage: runs inside an actual VS Code Extension
// Development Host (launched by ../runTests.js) with the extension
// loaded and the fixture repo (../fixtures/setup.js) open as the
// workspace. Interactive prompts (QuickPick/InputBox) are stubbed with
// sinon rather than clicked, but every command below executes through
// the real `vscode.commands.executeCommand` -> extension.ts pipeline,
// including real git operations (via simple-git) and, for composeCommit,
// the real built-in `vscode.git` extension's SCM input box.
//
// Every command in extension.ts is registered as `() => void handler()`
// (fire-and-forget, consistent throughout the file) — so
// `executeCommand()` resolves as soon as the synchronous part of the
// callback returns, well before the async flow (QuickPicks, git calls,
// clipboard writes, ...) has finished. Tests below never assert
// immediately after `executeCommand`; they poll for the expected side
// effect instead.
const assert = require("assert");
const { execFileSync } = require("child_process");
const path = require("path");
const sinon = require("sinon");
const vscode = require("vscode");

const EXTENSION_ID = "local-dev.remote-project-manager";
const WORKSPACE_DIR = path.resolve(__dirname, "..", "fixtures", "workspace");

function gitLog() {
  const raw = execFileSync("git", ["log", "--format=%h %s"], {
    cwd: WORKSPACE_DIR,
    encoding: "utf8",
  });
  return raw.trim().split("\n");
}

async function waitFor(predicate, timeoutMs = 8000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor timed out");
}

/** Polls the clipboard until it differs from `previousValue`, then returns the new value. */
async function waitForClipboardChange(previousValue, timeoutMs = 8000) {
  return waitFor(async () => {
    const text = await vscode.env.clipboard.readText();
    return text !== previousValue ? text : undefined;
  }, timeoutMs);
}

async function getGitApi() {
  const gitExtension = vscode.extensions.getExtension("vscode.git");
  assert.ok(gitExtension, "built-in vscode.git extension not found");
  const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
  return exports.getAPI(1);
}

async function getFixtureRepository() {
  const api = await getGitApi();
  return waitFor(() =>
    api.repositories.find((candidate) => candidate.rootUri.fsPath === WORKSPACE_DIR),
  );
}

async function findQuickPickItem(itemsOrPromise, predicate, title) {
  const items = await itemsOrPromise;
  const match = items.find(predicate);
  assert.ok(match, `no QuickPick item matched for "${title}". Items: ${JSON.stringify(items)}`);
  return match;
}

describe("Remote Project Manager — integration", () => {
  afterEach(() => {
    sinon.restore();
  });

  // Must run before anything calls `extension.activate()` explicitly:
  // opening a folder restarts the extension host and nothing reveals the
  // sidebar or runs a command, so activation has to come from
  // `onStartupFinished` for the repository sync to run.
  it("activates on startup without any command or view reveal", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} not found`);
    await waitFor(() => extension.isActive, 15000);
  });

  it("activates and exposes RemoteProjectManagerApi", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} not found`);
    const api = await extension.activate();
    assert.strictEqual(typeof api.getActiveIssueContext, "function");
  });

  it("registers every contributed command", async () => {
    const commands = await vscode.commands.getCommands(true);
    const expected = [
      "remoteProjectManager.openPanel",
      "remoteProjectManager.signOutGitLab",
      "remoteProjectManager.newIssue",
      "remoteProjectManager.newMilestone",
      "remoteProjectManager.refresh",
      "remoteProjectManager.composeCommit",
      "remoteProjectManager.pickGitmoji",
      "remoteProjectManager.copyIssueContext",
      "remoteProjectManager.createPrFromIssue",
      "remoteProjectManager.showGitGraph",
      "remoteProjectManager.lintCommitHistory",
      "remoteProjectManager.exportMilestoneContext",
    ];
    for (const command of expected) {
      assert.ok(commands.includes(command), `command not registered: ${command}`);
    }
  });

  describe("pickGitmoji", () => {
    it("copies the chosen gitmoji to the clipboard when there is no active editor", async () => {
      await vscode.env.clipboard.writeText("sentinel-before");
      sinon
        .stub(vscode.window, "showQuickPick")
        .callsFake((items) =>
          findQuickPickItem(items, (item) => item.gitmoji.code === ":sparkles:"),
        );

      void vscode.commands.executeCommand("remoteProjectManager.pickGitmoji");

      const clipboard = await waitForClipboardChange("sentinel-before");
      assert.strictEqual(clipboard, "✨");
    });

    it("does nothing when the picker is cancelled", async () => {
      await vscode.env.clipboard.writeText("sentinel-unchanged");
      const showQuickPick = sinon.stub(vscode.window, "showQuickPick").resolves(undefined);

      void vscode.commands.executeCommand("remoteProjectManager.pickGitmoji");
      await waitFor(() => showQuickPick.called);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const clipboard = await vscode.env.clipboard.readText();
      assert.strictEqual(clipboard, "sentinel-unchanged");
    });
  });

  describe("composeCommit", () => {
    it("composes a message and writes it to the SCM input box (golden path)", async () => {
      const repository = await getFixtureRepository();
      repository.inputBox.value = "";

      sinon.stub(vscode.window, "showQuickPick").callsFake((items, options) => {
        if (options.title === "Commit type") {
          return findQuickPickItem(items, (item) => item.label === "feat", options.title);
        }
        if (options.title === "Pick a Gitmoji") {
          return findQuickPickItem(
            items,
            (item) => item.gitmoji.code === ":sparkles:",
            options.title,
          );
        }
        if (options.title && options.title.startsWith("Link this commit to issue")) {
          return findQuickPickItem(
            items,
            (item) => item.label.startsWith("Fixes #"),
            options.title,
          );
        }
        throw new Error(`Unexpected showQuickPick call: ${options.title}`);
      });
      sinon.stub(vscode.window, "showInputBox").callsFake((options) => {
        if (options.title === "Scope (optional)") {
          return "core";
        }
        if (options.title === "Description") {
          return "add integration test coverage";
        }
        throw new Error(`Unexpected showInputBox call: ${options.title}`);
      });

      void vscode.commands.executeCommand("remoteProjectManager.composeCommit");

      const finalValue = await waitFor(() =>
        repository.inputBox.value !== "" ? repository.inputBox.value : undefined,
      );
      assert.strictEqual(finalValue, "feat(core): ✨ add integration test coverage\n\nFixes #999");
    });

    it("aborts cleanly without touching the SCM input box when the type picker is cancelled", async () => {
      const repository = await getFixtureRepository();
      repository.inputBox.value = "sentinel-untouched";
      const showQuickPick = sinon.stub(vscode.window, "showQuickPick").resolves(undefined);

      void vscode.commands.executeCommand("remoteProjectManager.composeCommit");
      await waitFor(() => showQuickPick.called);
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.strictEqual(repository.inputBox.value, "sentinel-untouched");
    });
  });

  describe("showGitGraph", () => {
    it("groups commits by referenced issue and copies the picked commit hash", async () => {
      await vscode.env.clipboard.writeText("sentinel-before");
      const log = gitLog();
      const issueCommitHashes = log
        .filter((line) => line.includes("correct thing") || line.includes("tidy up"))
        .map((line) => line.split(" ")[0]);
      assert.strictEqual(issueCommitHashes.length, 2);

      sinon.stub(vscode.window, "showQuickPick").callsFake((items, options) => {
        if (options.title === "Git Graph — grouped by issue") {
          return findQuickPickItem(items, (item) => item.label === "#999", options.title);
        }
        if (options.title === "#999") {
          return findQuickPickItem(items, () => true, options.title);
        }
        throw new Error(`Unexpected showQuickPick call: ${options.title}`);
      });

      void vscode.commands.executeCommand("remoteProjectManager.showGitGraph");

      const clipboard = await waitForClipboardChange("sentinel-before");
      assert.ok(
        issueCommitHashes.some((hash) => hash.startsWith(clipboard) || clipboard.startsWith(hash)),
        `clipboard "${clipboard}" did not match either #999 commit (${issueCommitHashes.join(", ")})`,
      );
    });
  });

  describe("lintCommitHistory", () => {
    it("flags the non-compliant commit and copies its suggested correction", async () => {
      await vscode.env.clipboard.writeText("sentinel-before");
      sinon
        .stub(vscode.window, "showQuickPick")
        .callsFake((items, options) =>
          findQuickPickItem(
            items,
            (item) => item.label.includes("Fixed the login bug"),
            options.title,
          ),
        );

      void vscode.commands.executeCommand("remoteProjectManager.lintCommitHistory");

      const clipboard = await waitForClipboardChange("sentinel-before");
      assert.strictEqual(clipboard, "fix: \u{1F41B} Fixed the login bug");
    });
  });

  describe("commands requiring a connected repository", () => {
    // The fixture repo has no remote and no `remoteProjectManager.repository`
    // setting, so resolveRepository() resolves to "none" for all three —
    // this is the real, user-facing "not connected" path.
    for (const [command, label] of [
      ["remoteProjectManager.copyIssueContext", "copyIssueContext"],
      ["remoteProjectManager.createPrFromIssue", "createPrFromIssue"],
      ["remoteProjectManager.exportMilestoneContext", "exportMilestoneContext"],
    ]) {
      it(`${label} reports "no connected repository" instead of throwing`, async () => {
        const showErrorMessage = sinon.stub(vscode.window, "showErrorMessage").resolves(undefined);

        void vscode.commands.executeCommand(command);

        await waitFor(() => showErrorMessage.called);
        assert.strictEqual(
          showErrorMessage.callCount,
          1,
          `${label}: expected exactly one showErrorMessage call, got ${showErrorMessage.callCount}`,
        );
        assert.match(showErrorMessage.firstCall.args[0], /No connected repository/);
      });
    }
  });

  describe("openPanel", () => {
    it("reports 'no repository detected' instead of throwing when no remote/config is set", async () => {
      const showErrorMessage = sinon.stub(vscode.window, "showErrorMessage").resolves(undefined);

      void vscode.commands.executeCommand("remoteProjectManager.openPanel");

      await waitFor(() => showErrorMessage.called);
      assert.strictEqual(showErrorMessage.callCount, 1);
      assert.match(showErrorMessage.firstCall.args[0], /No GitHub\/GitLab repository detected/);
    });
  });
});
