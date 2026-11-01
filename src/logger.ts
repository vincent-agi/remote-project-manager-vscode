import * as vscode from "vscode";
import { redactSecrets } from "./core/diagnostics/redact";

let channel: vscode.LogOutputChannel | undefined;

function getChannel(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel("Remote Project Manager", { log: true });
  return channel;
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Output channel logger. Every message is passed through
 * {@link redactSecrets}, so a token echoed back in a provider error can
 * never end up in the channel.
 */
export const logger = {
  info(message: string): void {
    getChannel().info(redactSecrets(message));
  },
  warn(message: string, detail?: unknown): void {
    getChannel().warn(
      redactSecrets(detail === undefined ? message : `${message}: ${describe(detail)}`),
    );
  },
  error(message: string, detail?: unknown): void {
    getChannel().error(
      redactSecrets(detail === undefined ? message : `${message}: ${describe(detail)}`),
    );
  },
  show(): void {
    getChannel().show(true);
  },
  dispose(): void {
    channel?.dispose();
    channel = undefined;
  },
};
