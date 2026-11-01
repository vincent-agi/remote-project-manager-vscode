import { extractIssueNumberFromBranch } from "../git/branch-issue-ref";
import { identityTranslate, type Translate } from "../i18n/translate";

/** The fields of an issue the status bar needs. */
export interface StatusBarIssue {
  readonly id: string;
  readonly number: number;
  readonly title: string;
}

/** What the extension currently knows about its connection to the remote. */
export type SyncState =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly issues: readonly StatusBarIssue[] }
  | { readonly kind: "auth-error" }
  | { readonly kind: "unavailable" };

export type StatusBarSeverity = "normal" | "warning" | "error";

/** Everything needed to render the status bar item, free of any `vscode` type. */
export interface StatusBarModel {
  readonly visible: boolean;
  readonly text: string;
  readonly tooltip: string;
  readonly severity: StatusBarSeverity;
  readonly command: string;
  readonly commandArguments: readonly unknown[];
}

const MAX_TITLE_LENGTH = 40;

const HIDDEN: StatusBarModel = {
  visible: false,
  text: "",
  tooltip: "",
  severity: "normal",
  command: "remoteProjectManager.openPanel",
  commandArguments: [],
};

function truncate(title: string): string {
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
}

/**
 * Decides what the status bar shows: the issue the current branch maps to
 * (via {@link extractIssueNumberFromBranch}), or the connection problem
 * that prevents knowing it. Hidden when there is no repository to talk to.
 */
export function buildStatusBarModel(
  branch: string | null,
  sync: SyncState,
  t: Translate = identityTranslate,
): StatusBarModel {
  switch (sync.kind) {
    case "unavailable":
      return HIDDEN;
    case "loading":
      return {
        ...HIDDEN,
        visible: true,
        text: "$(sync~spin) Remote Project Manager",
        tooltip: t("Syncing issues…"),
      };
    case "auth-error":
      return {
        ...HIDDEN,
        visible: true,
        text: t("$(error) Remote Project Manager: sign in"),
        tooltip: t("Authentication failed. Click to open the panel and sign in again."),
        severity: "error",
      };
    case "ok": {
      const number = branch === null ? null : extractIssueNumberFromBranch(branch);
      if (number === null) {
        return {
          ...HIDDEN,
          visible: true,
          text: t("$(circle-slash) No linked issue"),
          tooltip: branch
            ? t('Branch "{0}" does not reference an issue. Click to open the panel.', branch)
            : t("Click to open the panel."),
          severity: "warning",
        };
      }
      const issue = sync.issues.find((candidate) => candidate.number === number);
      if (!issue) {
        return {
          ...HIDDEN,
          visible: true,
          text: `$(issues) #${number}`,
          tooltip: t("Issue #{0} was not found on the remote. Click to open the panel.", number),
          severity: "warning",
        };
      }
      return {
        visible: true,
        text: `$(issues) #${issue.number} ${truncate(issue.title)}`,
        tooltip: `#${issue.number} ${issue.title}\n${t("Branch: {0}", branch ?? "")}\n${t("Click to open the issue.")}`,
        severity: "normal",
        command: "remoteProjectManager.openIssueFromTree",
        commandArguments: [issue.id],
      };
    }
  }
}
