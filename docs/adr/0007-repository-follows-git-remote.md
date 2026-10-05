# ADR-0007: The Connected Repository Follows the Git Remote

## Status

Accepted. Supersedes the precedence rule in ADR-0003 ("an explicit
`remoteProjectManager.repository` setting always wins").

## Context

`remoteProjectManager.repository` was authoritative and never refreshed.
When a user switched VS Code to another project, the setting (often a
user-level one) kept pointing at the old repository, so the issues and
milestones shown no longer matched the source code loaded.

## Decisions

### Detected remote wins; the setting is a fallback

`chooseRepository` (`src/core/workspace/repository-resolver.ts`) now
orders sources as: one detected `origin` remote, then a picker for
several, then the `repository`/`provider` settings, and only then
"none". The settings still serve folders with no (recognized) remote.

### The extension reacts to context changes

`registerRepositorySync` (`src/extension.ts`) re-resolves the repository,
debounced, on:

- workspace folders added/removed,
- changes to `repository`, `provider` or `gitlabHost`,
- changes to a folder's `.git/config` (e.g. `git remote set-url`).

The sidebar tree re-resolves on every render and rebuilds its connection
when the `repositoryKey` differs. An open panel whose key differs from
the one it was built for is disposed and reopened through the normal
resolve/pick flow.

## Consequences

- Issues/milestones always belong to the loaded repository, with no
  manual setting upkeep.
- Users who relied on the setting to point a folder at a _different_
  repository than its `origin` must now remove the remote or use a
  workspace with no recognized remote.
- The sidebar spawns one `git remote get-url` per workspace folder on
  each render — local and cheap, and API reads stay cached.
