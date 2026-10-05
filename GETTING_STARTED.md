# Getting Started with Remote Project Manager

This guide walks you through installing the extension and using it for the first time — no prior knowledge of the codebase needed. If you want architecture details or deep-dive behavior instead, see [`docs/functionals/`](docs/functionals/INDEX.md).

## What You Need

- VS Code, version 1.85 or newer.
- `git` installed and available in your terminal (type `git --version` to check). This is required for the automatic branch creation feature.
- A GitHub or GitLab account with access to the repository you want to manage.
- The extension's `.vsix` file (someone on your team built it, or you built it yourself — see [below](#dont-have-a-vsix-file-yet)).

## Step 1: Install the Extension

1. Open VS Code.
2. Open the **Extensions** view (the icon with four squares in the left sidebar, or `Cmd/Ctrl+Shift+X`).
3. Click the `...` (More Actions) menu at the top of the Extensions view.
4. Choose **Install from VSIX...**.
5. Pick the `remote-project-manager-<version>.vsix` file.
6. VS Code installs it and shows a confirmation. No restart is usually needed, but reload the window if the extension's command doesn't show up right away (`Cmd/Ctrl+Shift+P` → **Developer: Reload Window**).

### Don't have a `.vsix` file yet?

If you have the project's source code, build one yourself:

```bash
npm install
npm run package
```

This creates `remote-project-manager-<version>.vsix` in the project folder. Use that file in Step 1 above.

## Step 2: Point It at a Repository

The extension needs to know which GitHub or GitLab repository to manage. You have two options:

**Option A — Let it auto-detect (easiest).** Just open a VS Code workspace/folder that's a git clone of your repository — one with a normal `origin` remote pointing at `github.com` or `gitlab.com`. You don't need to configure anything; skip to Step 3.

**Option B — Set it manually.** Open your workspace settings (`Cmd/Ctrl+,`, then switch to the **Workspace** tab, or edit `.vscode/settings.json` directly) and add:

```json
{
  "remoteProjectManager.provider": "github",
  "remoteProjectManager.repository": "your-org/your-repo"
}
```

This is only a fallback: when the workspace has a recognized git `origin` remote, that remote is used instead (and followed when you switch project). Use `"gitlab"` for `provider` if your project lives on GitLab. `repository` is always `"owner/repo"` (GitHub) or `"namespace/project"` (GitLab).

> If your workspace has **multiple folders** that each point at a different repository, and you didn't set `remoteProjectManager.repository`, the extension will show you a picker the first time you open the panel — just click the one you want to work with.

## Step 3: Open the Panel

Either click the **Remote Project Manager** icon in the Activity Bar (left-hand sidebar) and then **Open Panel**, or open the Command Palette (`Cmd/Ctrl+Shift+P`) and run:

```
Remote Project Manager: Open Panel
```

A new tab opens in your editor area with the panel.

## Step 4: Sign In

The first time you connect to a given provider, you'll be asked to authenticate:

- **GitHub**: VS Code shows its normal sign-in prompt (a browser window opens to authorize). This happens through VS Code itself — the extension never sees or stores your GitHub password or token directly.
- **GitLab**: A box asks you to paste a **Personal Access Token**. If you don't have one:
  1. On GitLab, go to **User Settings → Access Tokens**.
  2. Create a token with the `api` scope (full read/write) or `read_api` (read-only, if you only want to view issues).
  3. Copy the token and paste it into the box in VS Code. It's saved securely and you won't be asked again.

## Step 5: Use the Panel

The panel has two tabs at the top: **Issues** and **Milestones**.

- **Browse**: click any item in the list on the left to see its details on the right.
- **Edit**: change the title, state (Open/Closed), or body/description, then click **Save**. Your change is pushed to GitHub/GitLab immediately.
- **Refresh**: click the **Refresh** button (top right) to pull the latest data right away, instead of waiting for the automatic refresh interval.
- **Filter by milestone**: open a milestone's details and click **View issues** to jump to the Issues tab pre-filtered to that milestone. Click the **Issues** tab again to clear the filter.

> If every field looks disabled (grayed out) and there's no Save button, your account only has read access to this repository — that's expected, not a bug.

## Step 6: Try Automatic Branch Creation

This is the extension's signature feature: when an issue **assigned to you** is marked "in progress," it can create and switch you to a correctly named git branch automatically.

1. On GitHub or GitLab directly (the panel doesn't have a labels editor yet), add the label `in-progress` to an issue that's assigned to you.
2. Back in VS Code, open the panel and click **Refresh** (or make any edit and save — either one causes the extension to notice the change).
3. If your working folder has no uncommitted changes, the extension fetches the latest code and switches you to a new branch automatically — you'll see a confirmation message with the branch name.
4. If you _do_ have uncommitted changes, a dialog asks what to do:
   - **Stash & Continue** — safely tucks your changes away first (get them back later with `git stash pop`), then proceeds.
   - **Force Switch** — proceeds anyway; git carries your changes over if it can.
   - **Cancel** — does nothing.

Don't want this to happen automatically? Turn it off in settings:

```json
{
  "remoteProjectManager.autoBranchOnInProgress": false
}
```

With it off, you still get a message suggesting the branch name — you just create it yourself.

**Prefer to trigger it yourself?** Open any issue's detail pane and click **Create branch**. You'll be asked to pick a base branch from a search-select list (fetched fresh from `origin`, with `main`/`master` listed first), then the same safety sequence above runs.

Want a different branch name shape (e.g. no type prefix, or a custom separator)? Set `remoteProjectManager.branchNamePattern` in settings — default is `${type}/${issue_id}-${slug}`. Full placeholder reference and examples: [Branch Name Pattern](docs/functionals/03-automated-branch-workflow.md#branch-name-pattern).

## What's Next

- Something not working? Check [Troubleshooting and FAQ](docs/functionals/04-troubleshooting-and-faq.md).
- Want to understand exactly how branch names are generated, or how caching/permissions work? See the full guides in [`docs/functionals/`](docs/functionals/INDEX.md).
- Full settings reference: see the [README](README.md#extension-settings).
- Ready for a standardized commit format and AI-agent context export? See [Git Automation and AI Context Commands](docs/functionals/05-git-automation-and-ai-context.md).
