import * as vscode from "vscode";
import * as path from "path";

let busy = false;
let log: vscode.OutputChannel;

// URIs we've already placed while they're open, so we don't fight manual drags
// (tab "changed" events fire for many reasons: dirty state, focus, moves...).
const handled = new Set<string>();

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("Tab Grouper for Angular");
  context.subscriptions.push(log);
  log.appendLine("Activated.");

  // Files already open at startup count as handled.
  for (const t of allTabs()) {
    const u = uriOf(t);
    if (u) handled.add(u.toString());
  }

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(async (e) => {
      if (busy) return;

      // Forget URIs that are no longer open (covers replaced preview tabs too).
      const open = new Set(
        allTabs()
          .map((t) => uriOf(t)?.toString())
          .filter(Boolean) as string[],
      );
      for (const u of [...handled]) if (!open.has(u)) handled.delete(u);

      // Clicking a file usually *replaces* the preview tab -> "changed", not "opened".
      const candidates = [...e.opened, ...e.changed];
      for (const tab of candidates) {
        const uri = uriOf(tab);
        if (!uri || handled.has(uri.toString())) continue;
        handled.add(uri.toString());
        // Let VS Code finish activating the tab before we move it.
        await new Promise((r) => setTimeout(r, 50));
        await placeNextToSiblings(uri);
      }
    }),
  );
}

export function deactivate() {}

function allTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs);
}

function uriOf(tab: vscode.Tab): vscode.Uri | undefined {
  return tab.input instanceof vscode.TabInputText ? tab.input.uri : undefined;
}

/** "user-card.component.ts" -> "user-card" (optionally prefixed with its folder). */
function groupKey(uri: vscode.Uri | undefined): string | undefined {
  if (!uri || uri.scheme !== "file") return undefined;
  const stem = path.basename(uri.fsPath).split(".")[0];
  if (!stem) return undefined; // dotfiles like .gitignore

  const sameFolder = vscode.workspace
    .getConfiguration("angularTabGrouper")
    .get<boolean>("sameFolderOnly", true);

  const key = sameFolder ? path.join(path.dirname(uri.fsPath), stem) : stem;
  return key.toLowerCase();
}

async function placeNextToSiblings(uri: vscode.Uri) {
  const name = path.basename(uri.fsPath);
  const key = groupKey(uri);
  if (!key) return;

  // Re-read fresh state after the delay.
  const group = vscode.window.tabGroups.activeTabGroup;
  const tabs = group.tabs;
  const myIndex = tabs.findIndex(
    (t) => uriOf(t)?.toString() === uri.toString(),
  );
  if (myIndex === -1) {
    log.appendLine(`${name}: not in active group, skipping.`);
    return;
  }
  const me = tabs[myIndex];
  if (!me.isActive || me.isPinned) {
    log.appendLine(`${name}: not active or pinned, skipping.`);
    return;
  }

  const siblingIndexes = tabs
    .map((t, i) =>
      i !== myIndex && !t.isPinned && groupKey(uriOf(t)) === key ? i : -1,
    )
    .filter((i) => i !== -1);
  if (siblingIndexes.length === 0) {
    log.appendLine(`${name}: no siblings open.`);
    return;
  }

  // Index each sibling would have once our tab is taken out of the row.
  const withoutMe = (i: number) => (i > myIndex ? i - 1 : i);

  // Insert before the first sibling that sorts after us; otherwise after the last one.
  const nameOf = (i: number) => path.basename(uriOf(tabs[i])!.fsPath);
  const firstAfter = siblingIndexes.find(
    (i) =>
      nameOf(i).localeCompare(name, undefined, {
        sensitivity: "base",
        numeric: true,
      }) > 0,
  );
  const target =
    firstAfter !== undefined
      ? withoutMe(firstAfter)
      : withoutMe(Math.max(...siblingIndexes)) + 1; // 0-based
  if (target === myIndex) {
    log.appendLine(`${name}: already next to siblings.`);
    return;
  }

  log.appendLine(`${name}: moving from ${myIndex} to ${target}.`);
  busy = true;
  try {
    await vscode.commands.executeCommand("moveActiveEditor", {
      to: "position",
      by: "tab",
      value: target + 1, // 1-based
    });
  } catch (err) {
    log.appendLine(`${name}: move failed: ${err}`);
  } finally {
    busy = false;
  }
}
