import type { ProviderKind } from "../models/issue.model";
import type { ProviderCapabilities } from "../providers/project-provider.interface";
import type { RepositoryResolution } from "../workspace/repository-resolver";
import { redactSecrets } from "./redact";

/** Result of one diagnostic probe. */
export interface DiagnosticCheck {
  readonly name: string;
  readonly status: "ok" | "warning" | "error";
  readonly detail: string;
}

/** Raw facts collected by the "Run diagnostics" command. */
export interface DiagnosticsInput {
  readonly extensionVersion: string;
  readonly vscodeVersion: string;
  readonly resolution: RepositoryResolution;
  /** `undefined` when no provider could be determined (nothing to check a token for). */
  readonly tokenProvider?: ProviderKind;
  readonly tokenStored: boolean;
  readonly connection?:
    | { readonly ok: true; readonly username: string; readonly capabilities: ProviderCapabilities }
    | { readonly ok: false; readonly error: string };
}

function describeResolution(resolution: RepositoryResolution): DiagnosticCheck {
  switch (resolution.kind) {
    case "resolved":
      return {
        name: "Remote detected",
        status: "ok",
        detail: `${resolution.providerKind}:${resolution.repository}${
          resolution.folderPath ? ` (folder: ${resolution.folderPath})` : ""
        }`,
      };
    case "candidates":
      return {
        name: "Remote detected",
        status: "warning",
        detail: `${resolution.candidates.length} candidates; pick one in the panel (${resolution.candidates
          .map((candidate) => `${candidate.provider}:${candidate.repository}`)
          .join(", ")}).`,
      };
    case "none":
      return {
        name: "Remote detected",
        status: "error",
        detail:
          "No GitHub/GitLab 'origin' remote found and 'remoteProjectManager.repository' is not set.",
      };
  }
}

/** Turns collected facts into an ordered list of checks. Pure. */
export function buildDiagnosticChecks(input: DiagnosticsInput): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [describeResolution(input.resolution)];
  if (!input.tokenProvider) {
    return checks;
  }
  checks.push({
    name: "Token stored",
    status: input.tokenStored ? "ok" : "error",
    detail: input.tokenStored
      ? `A ${input.tokenProvider} token is stored in SecretStorage.`
      : `No ${input.tokenProvider} token stored; you will be prompted on next connect.`,
  });
  if (!input.connection) {
    return checks;
  }
  if (!input.connection.ok) {
    checks.push({ name: "Connection", status: "error", detail: input.connection.error });
    return checks;
  }
  const { username, capabilities } = input.connection;
  checks.push({ name: "Connection", status: "ok", detail: `Authenticated as ${username}.` });
  for (const key of [
    "canReadIssues",
    "canWriteIssues",
    "canReadMilestones",
    "canWriteMilestones",
  ] as const) {
    checks.push({
      name: key,
      status: capabilities[key] ? "ok" : "warning",
      detail: String(capabilities[key]),
    });
  }
  return checks;
}

const STATUS_MARK = { ok: "[ok]", warning: "[warn]", error: "[fail]" } as const;

/** Renders the plain-text report shown in the output channel and copied to the clipboard. */
export function formatDiagnosticsReport(input: DiagnosticsInput): string {
  const lines = [
    "Remote Project Manager diagnostics",
    `Extension: ${input.extensionVersion}`,
    `VS Code: ${input.vscodeVersion}`,
    "",
    ...buildDiagnosticChecks(input).map(
      (check) => `${STATUS_MARK[check.status]} ${check.name}: ${check.detail}`,
    ),
  ];
  return redactSecrets(lines.join("\n"));
}
