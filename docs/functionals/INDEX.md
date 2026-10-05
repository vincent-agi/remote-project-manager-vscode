# Functional Documentation Index

Deep-dive guides for how Remote Project Manager actually works. Start with the [root README](../../README.md) for installation and settings; come here for behavior details.

| #   | Guide                                                                         | Summary                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 01  | [Authentication and Security](01-authentication-and-security.md)              | How GitHub (native VS Code session) and GitLab (PAT + `SecretStorage`) authentication work, recommended token scopes, and the security guarantees around credential storage.                           |
| 02  | [Issues and Milestones Management](02-issues-and-milestones-management.md)    | Opening the central panel, how repository detection and the multi-root picker work, and how to view/edit Issues and Milestones — including read-only mode.                                             |
| 03  | [Automated Branch Workflow](03-automated-branch-workflow.md)                  | How and when a branch is auto-created for an issue moving to "in progress," the dirty-working-tree safety sequence, and the branch naming pattern and sanitization rules.                              |
| 04  | [Troubleshooting and FAQ](04-troubleshooting-and-faq.md)                      | Caching/rate-limit behavior, resetting a stored token, git merge conflicts and default-branch resolution, missing/self-hosted remotes, and packaging a `.vsix`.                                        |
| 05  | [Git Automation and AI Context Commands](05-git-automation-and-ai-context.md) | Compose Commit, Pick Gitmoji, Copy Issue Context, Create PR from Issue, Show Git Graph, Lint Commit History, and Export Milestone Context — how "active issue" resolution and Gitmoji validation work. |

## Architectural Decision Records

For _why_ the extension is built this way (not just how to use it), see [`docs/adr/`](../adr/):

- [0001 — Architecture and Central Panel Choice](../adr/0001-architecture.md)
- [0002 — Issue Transition Hooks and Branch Naming Convention](../adr/0002-automation-hooks.md)
- [0003 — V1 Hardening: Auth, Caching, Multi-root, Webview State](../adr/0003-v1-hardening.md)
- [0004 — Auto-Branch Creation: Git Execution Safety and Naming](../adr/0004-auto-branch-creation.md)
- [0005 — Git Automation and AI Context Export Commands](../adr/0005-git-automation-and-ai-context.md)
- [0006 — V3 Hardening: Concurrency, Path Safety, and Provider Capability Corrections](../adr/0006-v3-hardening.md)
- [0007 — The Connected Repository Follows the Git Remote](../adr/0007-repository-follows-git-remote.md)
