# Contributing

This is a VS Code extension. This guide covers building, testing, and packaging it end to end.

## Prerequisites

- Node.js 18 or later.
- `git` on your `PATH` (the auto-branch feature shells out to it).
- A GitHub or GitLab account, for manually testing against a real repository.

## Setup

```bash
npm install
npm run compile
```

`compile` runs two separate `tsc` invocations — see [The webview's no-bundler constraint](#the-webviews-no-bundler-constraint) for why there are two — and is a quick way to confirm both TypeScript projects still build before you dig further.

## Running the extension

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded. To point it at a specific repository without relying on git-remote auto-detection, set `remoteProjectManager.repository` (and `remoteProjectManager.provider`) in that development window's settings.

## Testing

```bash
npm test          # vitest run, once
npm run test:watch
```

Test files live under `test/`, mirroring `src/`'s structure. New logic should come with a colocated test — see any existing file under `test/core/` or `test/providers/` for the pattern.

## Linting and formatting

```bash
npm run lint          # eslint .
npm run format        # prettier --write .
npm run format:check  # prettier --check . — what CI runs
```

`eslint.config.js` runs type-checked rules over `src/**` + `test/**` (against `tsconfig.eslint.json`, a lint-only superset of `tsconfig.json` that also includes `test/`) and separately over `src/webview-ui/**` (against `tsconfig.webview.json`). A couple of rules are turned off specifically for `test/**` where they're well-known vitest mock/matcher false positives — see the comments in `eslint.config.js` before assuming a similar finding elsewhere in `src/` is also a false positive.

## The webview has no bundler

`src/webview-ui/*.ts` compiles under `tsconfig.webview.json` to plain ES modules in `dist/webview-ui/`, loaded by the page with `<script type="module">`. There is no bundler, so:

- **Import siblings with a `.js` extension** (`import { renderMarkdown } from "./markdown.js"`): the browser sees the compiled files, and Vitest resolves the same specifier to the `.ts` source, so pure modules are unit tested directly from `test/webview-ui/`.
- **Keep logic in small pure modules** (`issue-view-model.ts`, `markdown.ts`, `graph-layout.ts`, ...) and keep `main.ts` for DOM wiring.
- **The webview cannot import from the extension host** (`src/core`, `src/webview/messages.ts`): the two programs have separate `rootDir`s and the host emits CommonJS to the same `dist/`. The message shapes are therefore mirrored by hand at the top of `main.ts`; when you change `src/webview/messages.ts`, update that copy. The few helpers both sides need (e.g. `priorityOf`) exist twice, with a parity test.
- **The CSP forbids inline `style` attributes**: set styles through the DOM API (`element.style...`) or use classes, and prefer native elements such as `<progress>`.

## Localization

English and French are supported. Messages are keyed by their English text:

- the manifest uses `%key%` placeholders resolved from `package.nls.json` / `package.nls.fr.json`;
- the extension host uses `vscode.l10n.t("...")` (and an injected `t` in `src/core`, which must not import `vscode`), translated in `l10n/bundle.l10n.fr.json`;
- the webview uses `t("...")` from `src/webview-ui/i18n.ts`, translated in `src/webview-ui/translations.ts`; the page shell (`src/webview/webview-html.ts`) is translated by the host.

`test/l10n-bundle.test.ts` and `test/manifest-nls.test.ts` fail when a message has no French entry, an entry is stale, or a `{0}` placeholder is lost. Wrap new user-visible text in `t(...)` and add its French translation in the same change.

## Packaging

```bash
npm run package
```

Compiles the extension and runs `vsce package`, producing `remote-project-manager-<version>.vsix` in the project root. You may see warnings like `LICENSE not found` — informational, and don't prevent packaging or installing the extension locally; they only matter if you plan to publish to the VS Code Marketplace.

## Releasing

Releases are automated by [release-please](https://github.com/googleapis/release-please) from [Conventional Commits](https://www.conventionalcommits.org/): `feat` makes a minor release, `fix` a patch, and `!` or a `BREAKING CHANGE:` footer a major one. After merging to `main`, release-please opens a "chore(main): release x.y.z" pull request that updates `package.json` and `CHANGELOG.md`; merging it tags the release and runs the `publish` job, which packages the extension, attaches the `.vsix` to the GitHub release and, when the tokens exist, publishes it.

To publish to the registries:

1. Set `publisher` in `package.json` to your [Marketplace publisher](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) id (it is `local-dev` until you do, which the Marketplace rejects) and the same namespace on [Open VSX](https://open-vsx.org).
2. Add the repository secrets `VSCE_PAT` (Azure DevOps token with Marketplace _Manage_ scope) and `OVSX_PAT` (Open VSX token). A registry without its secret is skipped, and the package is still attached to the release.

## Where to look next

- [`docs/adr/`](docs/adr/) — architectural decisions and the reasoning behind them.
- [`docs/functionals/`](docs/functionals/INDEX.md) — user-facing behavior, panel by panel.

Check both before re-litigating a design question in a PR — there's a decent chance it's already been settled, with the tradeoffs written down.
