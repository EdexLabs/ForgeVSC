import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import {
  ensureBinary,
  forceUpdate,
  checkForUpdate,
  setCustomBinary,
  resetBinary,
  loadState,
  fetchLatestRelease,
} from './binaryManager';

import {
  findForgeConfig,
  readForgeConfig,
  openOrCreateForgeConfig,
} from './configReader';

import {
  createClient,
  startClient,
  stopClient,
  isRunning,
  getClient,
} from './lspClient';

// ─── Module-level singletons ───────────────────────────────────────────────

let outputChannel: vscode.OutputChannel;
let storageDir: string;
let statusBarItem: vscode.StatusBarItem;
const decorationsByUri = new Map<string, vscode.TextEditorDecorationType[]>();

// ─── Status bar ────────────────────────────────────────────────────────────

function setStatus(text: string, tooltip?: string, command?: string): void {
  statusBarItem.text = `$(symbol-function) ${text}`;
  statusBarItem.tooltip = tooltip ?? 'ForgeLSP';
  statusBarItem.command = command ?? 'forgescript.showStatus';
  statusBarItem.show();
}

// ─── Start / stop helpers ──────────────────────────────────────────────────

async function doStart(): Promise<void> {
  setStatus('ForgeLSP: Starting…');
  try {
    const state = await ensureBinary(storageDir, outputChannel);

    const configPath = findForgeConfig();
    const initOptions = configPath
      ? readForgeConfig(configPath, outputChannel)
      : null;

    if (!configPath) {
      outputChannel.appendLine('[ForgeLSP] No forgeconfig.json found in workspace root.');
    }

    const client = createClient(state.binaryPath, initOptions, outputChannel, storageDir);
    registerNotificationListeners(client);
    await startClient(client);

    const tag = state.isCustom
      ? 'custom'
      : (state.installedTag ?? 'unknown');
    setStatus(
      `ForgeLSP: Running (${tag})`,
      `ForgeLSP is active. Binary: ${state.binaryPath}`,
      'forgescript.showStatus'
    );
    outputChannel.appendLine(`[ForgeLSP] Server started. Binary: ${state.binaryPath}`);
  } catch (err) {
    setStatus('ForgeLSP: Error', `${err}`, 'forgescript.openLog');
    outputChannel.appendLine(`[ForgeLSP] ✗ Failed to start: ${err}`);
    vscode.window.showErrorMessage(`ForgeLSP: Failed to start — ${err}`);
  }
}

async function doStop(): Promise<void> {
  setStatus('ForgeLSP: Stopping…');
  await stopClient();
  clearAllDecorations();
  setStatus('ForgeLSP: Stopped', 'ForgeLSP server is not running.', 'forgescript.start');
  outputChannel.appendLine('[ForgeLSP] Server stopped.');
}

async function doRestart(): Promise<void> {
  outputChannel.appendLine('[ForgeLSP] Restarting …');
  await doStop();
  await doStart();
}

// ─── Auto-update background check ─────────────────────────────────────────

async function backgroundUpdateCheck(): Promise<void> {
  try {
    const release = await checkForUpdate(storageDir);
    if (!release) return;

    const choice = await vscode.window.showInformationMessage(
      `ForgeLSP: Update available — ${release.tag}. Install now?`,
      'Update',
      'Later'
    );
    if (choice !== 'Update') return;

    outputChannel.appendLine(`[ForgeLSP] Auto-updating to ${release.tag} …`);
    await doStop();
    await forceUpdate(storageDir, outputChannel);
    await doStart();
    vscode.window.showInformationMessage(`ForgeLSP updated to ${release.tag}`);
  } catch (err) {
    // Silent failure — don't interrupt the user for update checks
    outputChannel.appendLine(`[ForgeLSP] Update check failed: ${err}`);
  }
}

// ─── Extension activate ────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('ForgeLSP');
  context.subscriptions.push(outputChannel);

  storageDir = context.globalStorageUri.fsPath;
  fs.mkdirSync(storageDir, { recursive: true });

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  context.subscriptions.push(statusBarItem);
  setStatus('ForgeLSP: Initializing…');

  outputChannel.appendLine('[ForgeLSP] Extension activated.');
  outputChannel.appendLine(`[ForgeLSP] Storage: ${storageDir}`);

  // ── Register commands ────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('forgescript.start', async () => {
      if (isRunning()) {
        vscode.window.showInformationMessage('ForgeLSP is already running.');
        return;
      }
      await doStart();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forgescript.stop', async () => {
      if (!isRunning()) {
        vscode.window.showInformationMessage('ForgeLSP is not running.');
        return;
      }
      await doStop();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forgescript.restart', async () => {
      await doRestart();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forgescript.forceUpdate', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'ForgeLSP: This will download and replace the current binary. Continue?',
        { modal: true },
        'Update'
      );
      if (confirm !== 'Update') return;

      try {
        setStatus('ForgeLSP: Updating…');
        const wasRunning = isRunning();
        if (wasRunning) await doStop();
        await forceUpdate(storageDir, outputChannel);
        if (wasRunning) await doStart();
        const state = loadState(storageDir);
        vscode.window.showInformationMessage(
          `ForgeLSP binary updated to ${state.installedTag ?? 'latest'}.`
        );
      } catch (err) {
        outputChannel.appendLine(`[ForgeLSP] Force-update failed: ${err}`);
        vscode.window.showErrorMessage(`ForgeLSP update failed: ${err}`);
        setStatus('ForgeLSP: Update failed', `${err}`, 'forgescript.openLog');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forgescript.checkForUpdates', async () => {
      try {
        vscode.window.showInformationMessage('ForgeLSP: Checking for updates…');
        const release = await checkForUpdate(storageDir);
        if (!release) {
          vscode.window.showInformationMessage('ForgeLSP: Already up to date.');
          return;
        }
        const choice = await vscode.window.showInformationMessage(
          `ForgeLSP update available: ${release.tag}`,
          'Update Now',
          'Later'
        );
        if (choice === 'Update Now') {
          await vscode.commands.executeCommand('forgescript.forceUpdate');
        }
      } catch (err) {
        outputChannel.appendLine(`[ForgeLSP] Check-for-updates failed: ${err}`);
        vscode.window.showErrorMessage(`ForgeLSP: Could not check for updates — ${err}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forgescript.setCustomBinary', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Select ForgeLSP binary',
        title: 'ForgeLSP: Select custom binary',
        filters: process.platform === 'win32'
          ? { 'Executables': ['exe'] }
          : undefined,
      });

      if (!uris || uris.length === 0) return;
      const binaryPath = uris[0].fsPath;

      const err = setCustomBinary(storageDir, binaryPath);
      if (err) {
        vscode.window.showErrorMessage(`ForgeLSP: ${err}`);
        return;
      }

      outputChannel.appendLine(`[ForgeLSP] Custom binary set: ${binaryPath}`);
      vscode.window.showInformationMessage(
        `ForgeLSP custom binary set: ${binaryPath}. Restarting…`
      );
      await doRestart();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forgescript.resetBinary', async () => {
      const state = loadState(storageDir);
      if (!state.isCustom) {
        vscode.window.showInformationMessage('ForgeLSP: Already using the official binary.');
        return;
      }

      resetBinary(storageDir);
      outputChannel.appendLine('[ForgeLSP] Reset to official binary.');

      const isWindows = process.platform === 'win32';
      const officialPath = path.join(storageDir, isWindows ? 'forgescript.exe' : 'ForgeLSP');
      const officialExists = require('fs').existsSync(officialPath);

      if (!officialExists) {
        const choice = await vscode.window.showInformationMessage(
          'ForgeLSP: Official binary not present. Download it now?',
          'Download',
          'Cancel'
        );
        if (choice !== 'Download') return;
      }

      await doRestart();
      vscode.window.showInformationMessage('ForgeLSP: Reset to official binary.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forgescript.showVersion', async () => {
      const state = loadState(storageDir);

      let latestTag = 'unknown';
      try {
        const release = await fetchLatestRelease();
        latestTag = release.tag;
      } catch {
        latestTag = '(could not fetch)';
      }

      if (state.isCustom) {
        vscode.window.showInformationMessage(
          `ForgeLSP: Using CUSTOM binary\nPath: ${state.binaryPath}\nLatest official: ${latestTag}`
        );
      } else {
        vscode.window.showInformationMessage(
          `ForgeLSP installed: ${state.installedTag ?? 'unknown'}\nLatest available: ${latestTag}\nBinary: ${state.binaryPath}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forgescript.showStatus', async () => {
      const state = loadState(storageDir);
      const running = isRunning();
      const client = getClient();

      const lines: string[] = [
        `Status:        ${running ? '✓ Running' : '✗ Stopped'}`,
        `Binary:        ${state.binaryPath || '(none)'}`,
        `Version:       ${state.isCustom ? 'custom' : (state.installedTag ?? 'unknown')}`,
        `Custom binary: ${state.isCustom ? 'Yes' : 'No'}`,
        `Storage dir:   ${storageDir}`,
        `Config:        ${findForgeConfig() ?? '(none)'}`,
      ];

      const panel = vscode.window.createOutputChannel('ForgeLSP Status');
      panel.clear();
      panel.appendLine('─── ForgeLSP Status ───────────────────────────');
      lines.forEach((l) => panel.appendLine(l));
      panel.appendLine('────────────────────────────────────────────────');
      panel.show(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forgescript.openLog', () => {
      outputChannel.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forgescript.reloadConfig', async () => {
      outputChannel.appendLine('[ForgeLSP] Reloading configuration…');
      await doRestart();
      vscode.window.showInformationMessage('ForgeLSP: Configuration reloaded.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forgescript.openConfig', async () => {
      await openOrCreateForgeConfig(outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forgescript.createConfig', async () => {
      await openOrCreateForgeConfig(outputChannel);
    })
  )
  // ── Watch forgeconfig.json for changes ───────────────────────────────────

  const configWatcher = vscode.workspace.createFileSystemWatcher('**/forgeconfig.json');
  context.subscriptions.push(configWatcher);

  configWatcher.onDidChange(async (uri) => {
    outputChannel.appendLine(`[ForgeLSP] forgeconfig.json changed (${uri.fsPath}), restarting…`);
    await doRestart();
  });

  configWatcher.onDidCreate(async (uri) => {
    outputChannel.appendLine(`[ForgeLSP] forgeconfig.json created (${uri.fsPath}), restarting…`);
    await doRestart();
  });

  configWatcher.onDidDelete(async () => {
    outputChannel.appendLine('[ForgeLSP] forgeconfig.json deleted, restarting with empty config…');
    await doRestart();
  });

  // ── Client Lifecycle ───────────────────────────────────────────────────────
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => {
    const uri = doc.uri.toString();
    const decorations = decorationsByUri.get(uri);
    if (decorations) {
      decorations.forEach(d => d.dispose());
      decorationsByUri.delete(uri);
    }
  }));

  // ── Initial start ─────────────────────────────────────────────────────────
  await doStart();

  // ── Background update check (after 10 s to not slow startup) ─────────────
  setTimeout(() => backgroundUpdateCheck(), 10_000);
}

// ─── Helpers for Notifications & Decorations ────────────────────────────────

function clearAllDecorations(): void {
  for (const decorations of decorationsByUri.values()) {
    decorations.forEach(d => d.dispose());
  }
  decorationsByUri.clear();
}

function registerNotificationListeners(client: any): void {
  client.onNotification('forge/customColors', (params: { uri: string; tokens: { range: vscode.Range; color_index: number }[] }) => {
    const configPath = findForgeConfig();
    if (!configPath) return;

    const config = readForgeConfig(configPath, outputChannel);
    if (!config || !config.customColors || config.customColors.length === 0) {
      // Clear existing decorations if custom colors are disabled
      const existing = decorationsByUri.get(params.uri);
      if (existing) {
        existing.forEach(d => d.dispose());
        decorationsByUri.delete(params.uri);
      }
      return;
    }

    const colors = config.customColors;
    const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === params.uri);
    if (!editor) return;

    // Clear existing decorations for this URI
    const existing = decorationsByUri.get(params.uri);
    if (existing) {
      existing.forEach(d => d.dispose());
    }

    const newDecorations: vscode.TextEditorDecorationType[] = colors.map(c => vscode.window.createTextEditorDecorationType({
      color: c
    }));

    const rangesByColorIndex = new Map<number, vscode.Range[]>();
    for (const token of params.tokens) {
      if (!rangesByColorIndex.has(token.color_index)) {
        rangesByColorIndex.set(token.color_index, []);
      }
      // Notification uses LSP range (0-indexed), VS Code uses 0-indexed as well
      const range = new vscode.Range(
        token.range.start.line,
        token.range.start.character,
        token.range.end.line,
        token.range.end.character
      );
      rangesByColorIndex.get(token.color_index)!.push(range);
    }

    for (const [index, ranges] of rangesByColorIndex) {
      if (index < newDecorations.length) {
        editor.setDecorations(newDecorations[index], ranges);
      }
    }

    decorationsByUri.set(params.uri, newDecorations);
  });
}

// ─── Extension deactivate ──────────────────────────────────────────────────

export async function deactivate(): Promise<void> {
  await stopClient();
}
