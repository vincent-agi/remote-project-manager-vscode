import * as vscode from "vscode";
import { replaceManagedSection } from "./core/ai/managed-section";
import {
  digestContext,
  needsRegeneration,
  resolveAiContextTargets,
  type ResolvedAiContextTargets,
  type TrackedContext,
} from "./core/ai/context-targets";
import { formatMilestoneContext } from "./core/ai/milestone-context";
import type { IProjectProvider } from "./core/providers/project-provider.interface";
import { logger } from "./logger";

/** `workspaceState` key remembering which milestone was last exported and its content fingerprint. */
const TRACKED_KEY = "remoteProjectManager.aiContext";
const SECTION_NAME = "milestone-context";

/** Where the context should go, from the current settings. */
export function readAiContextTargets(): ResolvedAiContextTargets {
  const config = vscode.workspace.getConfiguration("remoteProjectManager");
  return resolveAiContextTargets(
    config.get<string>("aiContextFile", ""),
    config.get<string[]>("aiContextFiles", []),
  );
}

/**
 * Writes `block` into every target's managed section, creating files and
 * folders as needed and leaving the rest of each file untouched. Returns
 * the display paths of the files whose content actually changed.
 */
export async function writeContextFiles(
  cwd: string,
  block: string,
  targets: ResolvedAiContextTargets["targets"],
): Promise<string[]> {
  const changed: string[] = [];
  for (const target of targets) {
    const fileUri = vscode.Uri.joinPath(vscode.Uri.file(cwd), ...target.segments);
    let existing = "";
    try {
      existing = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString("utf8");
    } catch {
      // File doesn't exist yet — start from empty.
    }
    const updated = replaceManagedSection(existing, SECTION_NAME, block);
    if (updated === existing) {
      continue;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fileUri, ".."));
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(updated, "utf8"));
    changed.push(target.displayPath);
  }
  return changed;
}

/** Remembers the milestone just exported, so auto-update knows what to keep fresh. */
export async function trackExportedContext(
  context: vscode.ExtensionContext,
  tracked: TrackedContext,
): Promise<void> {
  await context.workspaceState.update(TRACKED_KEY, tracked);
}

/**
 * Keeps the exported AI context files current (#106): after each sidebar
 * sync it rebuilds the context of the last exported milestone and rewrites
 * the files when, and only when, the content changed. Off unless
 * `aiContextAutoUpdate` is set, and it never exports a milestone the user
 * has not exported by hand first.
 */
export class AiContextSync {
  private running = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getProvider: () => IProjectProvider | undefined,
  ) {}

  async onSynced(folderPath: string | undefined): Promise<void> {
    const config = vscode.workspace.getConfiguration("remoteProjectManager");
    const tracked = this.context.workspaceState.get<TrackedContext>(TRACKED_KEY);
    const provider = this.getProvider();
    if (
      this.running ||
      !folderPath ||
      !provider ||
      !tracked ||
      !config.get<boolean>("aiContextAutoUpdate", false)
    ) {
      return;
    }
    this.running = true;
    try {
      const [milestones, issues] = await Promise.all([
        provider.listMilestones(),
        provider.listIssues(),
      ]);
      const milestone = milestones.find((candidate) => candidate.id === tracked.milestoneId);
      if (!milestone) {
        return;
      }
      const block = formatMilestoneContext(
        milestone,
        issues.filter((issue) => issue.milestoneId === milestone.id),
      );
      const digest = digestContext(block);
      if (!needsRegeneration(true, tracked, digest)) {
        return;
      }
      const { targets, rejected } = readAiContextTargets();
      if (rejected.length > 0) {
        logger.warn(`AI context: ignoring unsafe targets: ${rejected.join(", ")}`);
      }
      const changed = await writeContextFiles(folderPath, block, targets);
      await trackExportedContext(this.context, { milestoneId: milestone.id, digest });
      logger.info(
        `AI context: milestone "${milestone.title}" changed, updated ${changed.join(", ") || "no file"}`,
      );
    } catch (error) {
      logger.warn("AI context: could not refresh the context files", error);
    } finally {
      this.running = false;
    }
  }
}
