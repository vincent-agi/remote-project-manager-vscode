import { identityTranslate, type Translate } from "../i18n/translate";

export type SettingGroup = "connection" | "branches" | "automation" | "ai" | "editor";

export type SettingKind =
  | { readonly type: "boolean" }
  | { readonly type: "number"; readonly min: number }
  | { readonly type: "string" }
  | { readonly type: "enum"; readonly values: readonly string[] };

/**
 * Where an edit is written. Project conventions (which repository, how
 * branches are named) go to the workspace so they follow the project; personal
 * preferences go to the user settings, so editing them never touches a file
 * that may be committed.
 */
export type SettingScope = "workspace" | "user";

/** One setting the in-panel page can edit. Keys omit the `remoteProjectManager.` prefix. */
export interface SettingDescriptor {
  readonly key: string;
  readonly group: SettingGroup;
  readonly kind: SettingKind;
  readonly scope: SettingScope;
}

export const SETTING_DESCRIPTORS: readonly SettingDescriptor[] = [
  {
    key: "provider",
    group: "connection",
    kind: { type: "enum", values: ["github", "gitlab"] },
    scope: "workspace",
  },
  { key: "repository", group: "connection", kind: { type: "string" }, scope: "workspace" },
  { key: "gitlabHost", group: "connection", kind: { type: "string" }, scope: "workspace" },
  { key: "cacheTtlSeconds", group: "connection", kind: { type: "number", min: 0 }, scope: "user" },
  {
    key: "autoRefreshSeconds",
    group: "connection",
    kind: { type: "number", min: 0 },
    scope: "user",
  },
  { key: "autoBranchOnInProgress", group: "branches", kind: { type: "boolean" }, scope: "user" },
  { key: "branchNamePattern", group: "branches", kind: { type: "string" }, scope: "workspace" },
  {
    key: "syncMarkInProgressOnCommit",
    group: "automation",
    kind: { type: "boolean" },
    scope: "user",
  },
  { key: "syncRemindMissingIssue", group: "automation", kind: { type: "boolean" }, scope: "user" },
  { key: "syncProposeCloseOnMerge", group: "automation", kind: { type: "boolean" }, scope: "user" },
  { key: "aiContextFile", group: "ai", kind: { type: "string" }, scope: "workspace" },
  { key: "todoCodeLens", group: "editor", kind: { type: "boolean" }, scope: "user" },
];

export function describeGroup(group: SettingGroup, t: Translate = identityTranslate): string {
  switch (group) {
    case "connection":
      return t("Connection");
    case "branches":
      return t("Branches");
    case "automation":
      return t("Automation");
    case "ai":
      return t("AI context");
    case "editor":
      return t("Editor");
  }
}

/** Short label and a one-line hint for a setting. */
export function describeSetting(
  key: string,
  t: Translate = identityTranslate,
): { label: string; hint: string } {
  switch (key) {
    case "provider":
      return {
        label: t("Platform"),
        hint: t("Only used when no workspace folder has a recognized git remote."),
      };
    case "repository":
      return {
        label: t("Fallback repository"),
        hint: t("owner/repo, used when no git remote is recognized."),
      };
    case "gitlabHost":
      return {
        label: t("GitLab host"),
        hint: t("Hostname of a self-hosted GitLab (empty for gitlab.com)."),
      };
    case "cacheTtlSeconds":
      return {
        label: t("Cache duration (seconds)"),
        hint: t("How long reads are cached before refetching."),
      };
    case "autoRefreshSeconds":
      return {
        label: t("Auto-refresh (seconds)"),
        hint: t("0 turns it off; values under 30 are raised to 30."),
      };
    case "autoBranchOnInProgress":
      return {
        label: t("Create a branch when an issue moves to in-progress"),
        hint: t("When off, a suggested branch name is shown instead."),
      };
    case "branchNamePattern":
      return {
        label: t("Branch name pattern"),
        hint: t("Placeholders: ${type}, ${issue_id}, ${slug}."),
      };
    case "syncMarkInProgressOnCommit":
      return {
        label: t("Mark the issue in-progress after the first commit"),
        hint: t("Adds the in-progress label to an issue assigned to you."),
      };
    case "syncRemindMissingIssue":
      return {
        label: t("Remind me when a branch has no issue"),
        hint: t("Once per branch, when you commit on it."),
      };
    case "syncProposeCloseOnMerge":
      return {
        label: t("Offer to close issues closed by merged commits"),
        hint: t("Looks for Fixes/Closes/Resolves #N on the default branch."),
      };
    case "aiContextFile":
      return {
        label: t("AI context file"),
        hint: t("Workspace-relative file the milestone context is exported to."),
      };
    case "todoCodeLens":
      return {
        label: t("CodeLens on TODO/FIXME comments"),
        hint: t("Shows the linked issue or a 'Create issue' action."),
      };
    default:
      return { label: key, hint: "" };
  }
}

export type SettingValidation =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string };

/**
 * Checks a value coming from the webview against the descriptor's kind.
 * The webview is not trusted to send well-typed data: this runs in the
 * host before anything is written to the user's settings.
 */
export function validateSettingValue(
  descriptor: SettingDescriptor,
  value: unknown,
  t: Translate = identityTranslate,
): SettingValidation {
  const kind = descriptor.kind;
  switch (kind.type) {
    case "boolean":
      return typeof value === "boolean"
        ? { ok: true, value }
        : { ok: false, reason: t("Expected true or false.") };
    case "number":
      return typeof value === "number" && Number.isFinite(value) && value >= kind.min
        ? { ok: true, value }
        : { ok: false, reason: t("Expected a number of at least {0}.", kind.min) };
    case "string":
      return typeof value === "string"
        ? { ok: true, value: value.trim() }
        : { ok: false, reason: t("Expected text.") };
    case "enum":
      return typeof value === "string" && kind.values.includes(value)
        ? { ok: true, value }
        : { ok: false, reason: t("Expected one of: {0}.", kind.values.join(", ")) };
  }
}

/** The descriptor for `key`, or `undefined` when the page may not edit it. */
export function findSettingDescriptor(key: string): SettingDescriptor | undefined {
  return SETTING_DESCRIPTORS.find((descriptor) => descriptor.key === key);
}

/** A setting as the page shows it. */
export interface SettingEntry {
  readonly key: string;
  readonly group: SettingGroup;
  readonly groupLabel: string;
  readonly label: string;
  readonly hint: string;
  readonly kind: SettingKind;
  readonly scope: SettingScope;
  readonly value: unknown;
  readonly defaultValue: unknown;
  readonly isDefault: boolean;
}

/** Builds the page's entries from a reader over the live configuration. */
export function buildSettingEntries(
  read: (key: string) => { value: unknown; defaultValue: unknown },
  t: Translate = identityTranslate,
): SettingEntry[] {
  return SETTING_DESCRIPTORS.map((descriptor) => {
    const { value, defaultValue } = read(descriptor.key);
    return {
      key: descriptor.key,
      group: descriptor.group,
      groupLabel: describeGroup(descriptor.group, t),
      ...describeSetting(descriptor.key, t),
      kind: descriptor.kind,
      scope: descriptor.scope,
      value,
      defaultValue,
      isDefault: JSON.stringify(value) === JSON.stringify(defaultValue),
    };
  });
}
