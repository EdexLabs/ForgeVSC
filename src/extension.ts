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

import { initGuides } from './guides';
import { registerDocsView, runSearch } from './docsView';

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

interface DiagnosticSummaryParams {
  uri: string;
  error_count: number;
  warning_count: number;
  function_count: number;
}

const diagnosticSummaryByUri = new Map<string, DiagnosticSummaryParams>();

// ─── Diagnostic tree view ──────────────────────────────────────────────────

class DiagnosticsProvider implements vscode.TreeDataProvider<DiagnosticItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<DiagnosticItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: DiagnosticItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DiagnosticItem): DiagnosticItem[] {
    if (element) return [];

    const items: DiagnosticItem[] = [];
    for (const [uri, summary] of diagnosticSummaryByUri.entries()) {
      const label = vscode.Uri.parse(uri).fsPath.split('/').pop() ?? uri;
      const icon = summary.error_count > 0
        ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'))
        : summary.warning_count > 0
          ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'))
          : new vscode.ThemeIcon('pass');

      const desc = summary.error_count > 0
        ? `${summary.error_count} error(s)`
        : summary.warning_count > 0
          ? `${summary.warning_count} warning(s)`
          : 'No issues';

      const item = new DiagnosticItem(label, desc, uri, icon);
      items.push(item);
    }
    return items.sort((a, b) => {
      const sa = diagnosticSummaryByUri.get(a.uri)!;
      const sb = diagnosticSummaryByUri.get(b.uri)!;
      return (sb.error_count - sa.error_count) || (sb.warning_count - sa.warning_count);
    });
  }
}

class DiagnosticItem extends vscode.TreeItem {
  constructor(
    label: string,
    description: string,
    public readonly uri: string,
    icon: vscode.ThemeIcon
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = icon;
    this.command = {
      command: 'vscode.open',
      title: 'Open file',
      arguments: [vscode.Uri.parse(uri)],
    };
    this.tooltip = uri;
  }
}

let diagnosticsProvider: DiagnosticsProvider;
interface SimpleColorToken {
  range: vscode.Range;
}

interface CustomColorToken {
  range: vscode.Range;
  color_index: number;
}

interface CustomColorData {
  tokens: CustomColorToken[];
  text_tokens: SimpleColorToken[];
  time_tokens: SimpleColorToken[];
  number_tokens: SimpleColorToken[];
  dollar_tokens: SimpleColorToken[];
  modifier_tokens: SimpleColorToken[];
  boolean_tokens: SimpleColorToken[];
  separator_tokens: SimpleColorToken[];
}

const decorationsByUri = new Map<string, vscode.TextEditorDecorationType[]>();
const tokensByUri = new Map<string, CustomColorData>();

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
      : (state.installedReleaseId ?? 'unknown');
    setStatus(
      `ForgeLSP: Running (${tag})`,
      `ForgeLSP is active. Binary: ${state.binaryPath}`,
      'forgescript.showStatus'
    );
    outputChannel.appendLine(`[ForgeLSP] Server started. Binary: ${state.binaryPath}`);

    // Re-apply decorations to all visible editors once client starts
    vscode.window.visibleTextEditors.forEach(editor => applyDecorations(editor));
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
  tokensByUri.clear();
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
    vscode.commands.registerCommand('forgescript.wrapInComment', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selections = [...editor.selections];
      interface ResultInfo {
        newStartLine: number;
        newEndLine: number;
      }
      const postEditInfo: ResultInfo[] = [];
      let lineOffset = 0;

      await editor.edit(editBuilder => {
        for (const selection of selections) {
          const startLine = selection.start.line;
          let endLine = selection.end.line;

          if (selection.end.character === 0 && endLine > startLine) {
            endLine--;
          }

          const startLineText = editor.document.lineAt(startLine).text;
          const endLineText = editor.document.lineAt(endLine).text;

          // ── Unwrap path ──────────────────────────────────────────────────────
          if (startLineText.trim() === '$c[' && endLineText.trim() === ']') {
            const replacedLines: string[] = [];
            for (let i = startLine + 1; i < endLine; i++) {
              const lineText = editor.document.lineAt(i).text;
              replacedLines.push(lineText.startsWith('  ') ? lineText.substring(2) : lineText);
            }

            const newText = replacedLines.join('\n');
            const rangeToReplace = new vscode.Range(startLine, 0, endLine, endLineText.length);
            editBuilder.replace(rangeToReplace, newText);

            // Unwrap removes 2 lines ($c[ and ])
            const newStart = startLine + lineOffset;
            const newEnd = newStart + Math.max(0, replacedLines.length - 1);
            postEditInfo.push({ newStartLine: newStart, newEndLine: newEnd });
            lineOffset -= 2;
            continue;
          }

          // ── Wrap path ────────────────────────────────────────────────────────
          let minIndentStr: string | null = null;
          for (let i = startLine; i <= endLine; i++) {
            const line = editor.document.lineAt(i);
            if (!line.isEmptyOrWhitespace) {
              const indent = line.text.match(/^\s*/)?.[0] || '';
              if (minIndentStr === null || indent.length < minIndentStr.length) {
                minIndentStr = indent;
              }
            }
          }

          const baseIndent = minIndentStr || '';
          const replacedLines: string[] = [];
          for (let i = startLine; i <= endLine; i++) {
            const lineText = editor.document.lineAt(i).text;
            replacedLines.push(lineText.length > 0 ? `  ${lineText}` : lineText);
          }

          const newText = `${baseIndent}$c[\n${replacedLines.join('\n')}\n${baseIndent}]`;
          const rangeToReplace = new vscode.Range(
            startLine, 0,
            endLine, editor.document.lineAt(endLine).text.length
          );
          editBuilder.replace(rangeToReplace, newText);

          const newStart = startLine + lineOffset;
          const newEnd = endLine + lineOffset + 2;
          postEditInfo.push({ newStartLine: newStart, newEndLine: newEnd });
          lineOffset += 2;
        }
      });

      // Expand selections to cover each (now fully-commented) block
      if (postEditInfo.length > 0) {
        editor.selections = postEditInfo.map(({ newStartLine, newEndLine }) => {
          const clampedEnd = Math.min(newEndLine, editor.document.lineCount - 1);
          const endChar = editor.document.lineAt(clampedEnd).text.length;
          return new vscode.Selection(
            new vscode.Position(newStartLine, 0),
            new vscode.Position(clampedEnd, endChar)
          );
        });
      }
    })
  )

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
          `ForgeLSP binary updated to ${state.installedReleaseId ?? 'latest'}.`
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
          `ForgeLSP installed: ${state.installedReleaseId ?? 'unknown'}\nLatest available: ${latestTag}\nBinary: ${state.binaryPath}`
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
        `Version:       ${state.isCustom ? 'custom' : (state.installedReleaseId ?? 'unknown')}`,
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
  context.subscriptions.push(
    vscode.commands.registerCommand('forgescript.search', async () => {
      await runSearch();
    })
  );

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

  // ── Client Lifecycle & Editor Visibility ───────────────────────────────────
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => {
    const uri = doc.uri.toString();
    const decorations = decorationsByUri.get(uri);
    if (decorations) {
      decorations.forEach(d => d.dispose());
      decorationsByUri.delete(uri);
    }
    tokensByUri.delete(uri);
  }));

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor) applyDecorations(editor);
  }));

  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(editors => {
    editors.forEach(editor => applyDecorations(editor));
  }));

  // ── Guides sidebar ───────────────────────────────────────────────────────
  initGuides(context);
  registerDocsView(context, outputChannel);

  // ── Diagnostics tree view ─────────────────────────────────────────────────
  diagnosticsProvider = new DiagnosticsProvider();
  const diagnosticsTreeView = vscode.window.createTreeView('forgescript.diagnostics', {
    treeDataProvider: diagnosticsProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(diagnosticsTreeView);

  context.subscriptions.push(
    vscode.commands.registerCommand('forgescript.showDiagnostics', () => {
      diagnosticsTreeView.reveal(undefined as any, { focus: true }).then(() => { }, () => {
        vscode.commands.executeCommand('forgescript.diagnostics.focus');
      });
    })
  );

  // ── forgeconfig.json hover: show extension function counts ───────────────
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { language: 'json', pattern: '**/forgeconfig.json' },
      {
        provideHover(document, position) {
          const wordRange = document.getWordRangeAtPosition(position, /github:[^\s"]+/);
          if (!wordRange) return;
          const word = document.getText(wordRange);

          // Parse the forgeconfig to find how many functions this extension adds.
          const configPath = findForgeConfig();
          if (!configPath) return;
          const config = readForgeConfig(configPath, outputChannel);
          if (!config?.metadataUrls) return;

          const match = (config.metadataUrls as any[]).find(
            (m: any) => m.extension && word.includes(m.extension)
          );
          if (!match) return;

          const md = new vscode.MarkdownString(
            `**ForgeScript Extension**: \`${match.extension}\`\n\n` +
            (match.functions ? `Functions URL: ${match.functions}` : '') +
            '\n\nHover over the status bar badge to see function count after loading.'
          );
          return new vscode.Hover(md, wordRange);
        },
      }
    )
  );

  // ── Inline Bracket Suggestions ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      [
        { scheme: 'file', language: 'javascript' },
        { scheme: 'file', language: 'typescript' },
        { scheme: 'file', language: 'javascriptreact' },
        { scheme: 'file', language: 'typescriptreact' },
        { scheme: 'file', language: 'forge' },
      ],
      {
        async provideInlineCompletionItems(document, position, _context, _token) {
          const client = getClient();
          if (!client || !isRunning()) return undefined;

          // Standard check from lspClient
          const text = document.getText();
          const offset = document.offsetAt(position);
          let inside = document.languageId === 'forge';
          if (!inside) {
            let escaped = false;
            for (let i = 0; i < offset; i++) {
              if (escaped) { escaped = false; continue; }
              if (text[i] === '\\') { escaped = true; }
              else if (text[i] === '`') { inside = !inside; }
            }
          }
          if (!inside) return undefined;

          try {
            const result = await client.sendRequest('workspace/executeCommand', {
              command: 'forge.getInlineCompletions',
              arguments: [
                document.uri.toString(),
                position.line,
                position.character,
              ],
            }) as string[];

            if (!result || result.length === 0) return undefined;

            return result.map(text => {
              const item = new vscode.InlineCompletionItem(text);
              item.range = new vscode.Range(position, position);
              return item;
            });
          } catch (err) {
            outputChannel.appendLine(`[ForgeLSP] InlineCompletion error: ${err}`);
            return undefined;
          }
        },
      }
    )
  );

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

function applyDecorations(editor: vscode.TextEditor): void {
  const uri = editor.document.uri.toString();
  const data = tokensByUri.get(uri);
  if (!data) return;

  const configPath = findForgeConfig();
  if (!configPath) return;

  const config = readForgeConfig(configPath, outputChannel);
  if (!config) return;

  const hasColors = (config.customColors && config.customColors.length > 0) ||
    config.customColorText ||
    config.customColorTime ||
    config.customColorNumbers ||
    config.customColorSeparators ||
    config.customColorDollar ||
    config.customColorModifiers ||
    config.customColorBoolean;

  if (!hasColors) {
    // Clear existing decorations if custom colors are disabled or missing
    const existing = decorationsByUri.get(uri);
    if (existing) {
      existing.forEach(d => d.dispose());
      decorationsByUri.delete(uri);
    }
    return;
  }

  // Clear existing decorations for this URI before applying new ones
  const existing = decorationsByUri.get(uri);
  if (existing) {
    existing.forEach(d => d.dispose());
  }

  const newDecorations: vscode.TextEditorDecorationType[] = [];

  // Helper function to apply simple single-color tokens
  function applySimpleTokens(
    tokens: SimpleColorToken[],
    colorHex: string | undefined
  ) {
    if (!colorHex || !tokens || tokens.length === 0) return;
    const dec = vscode.window.createTextEditorDecorationType({ color: colorHex });
    newDecorations.push(dec);
    const ranges = tokens.map(t => new vscode.Range(
      t.range.start.line,
      t.range.start.character,
      t.range.end.line,
      t.range.end.character
    ));
    editor.setDecorations(dec, ranges);
  }

  // 1. Function name tokens (existing logic, color palette)
  if (config.customColors && config.customColors.length > 0 && data.tokens && data.tokens.length > 0) {
    const colors = config.customColors;
    const funcDecorations = colors.map(c => vscode.window.createTextEditorDecorationType({ color: c }));
    newDecorations.push(...funcDecorations);

    const rangesByColorIndex = new Map<number, vscode.Range[]>();
    for (const token of data.tokens) {
      if (!rangesByColorIndex.has(token.color_index)) {
        rangesByColorIndex.set(token.color_index, []);
      }
      const range = new vscode.Range(
        token.range.start.line,
        token.range.start.character,
        token.range.end.line,
        token.range.end.character
      );
      rangesByColorIndex.get(token.color_index)!.push(range);
    }

    for (const [index, ranges] of rangesByColorIndex) {
      if (index < funcDecorations.length) {
        editor.setDecorations(funcDecorations[index], ranges);
      }
    }
  }

  // 2. String/Text tokens
  applySimpleTokens(data.text_tokens, config.customColorText);

  // 3. Time tokens
  applySimpleTokens(data.time_tokens, config.customColorTime);

  // 4. Number tokens
  applySimpleTokens(data.number_tokens, config.customColorNumbers);

  // 5. Separator tokens
  applySimpleTokens(data.separator_tokens, config.customColorSeparators);

  // 6. Dollar tokens
  applySimpleTokens(data.dollar_tokens, config.customColorDollar);

  // 7. Modifier tokens
  applySimpleTokens(data.modifier_tokens, config.customColorModifiers);

  // 8. Boolean tokens
  applySimpleTokens(data.boolean_tokens, config.customColorBoolean);

  decorationsByUri.set(uri, newDecorations);
}

function registerNotificationListeners(client: any): void {
  client.onNotification('forge/customColors', (params: CustomColorData & { uri: string }) => {
    tokensByUri.set(params.uri, params);
    const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === params.uri);
    if (editor) {
      applyDecorations(editor);
    }
  });

  client.onNotification('forge/diagnosticSummary', (params: DiagnosticSummaryParams) => {
    diagnosticSummaryByUri.set(params.uri, params);

    // Aggregate totals across all open files
    let totalErrors = 0;
    let totalWarnings = 0;
    for (const s of diagnosticSummaryByUri.values()) {
      totalErrors += s.error_count;
      totalWarnings += s.warning_count;
    }

    // Update status bar badge
    const state = loadState(storageDir);
    const tag = state.isCustom ? 'custom' : (state.installedReleaseId ?? 'unknown');
    const badge = totalErrors > 0
      ? `$(error) ${totalErrors}`
      : totalWarnings > 0
        ? `$(warning) ${totalWarnings}`
        : '$(check)';
    setStatus(
      `ForgeLSP (${tag}) ${badge}`,
      `ForgeLSP running · ${totalErrors} error(s), ${totalWarnings} warning(s)`,
      'forgescript.showDiagnostics'
    );

    // Refresh the diagnostics tree
    diagnosticsProvider.refresh();
  });
}

// ─── Extension deactivate ──────────────────────────────────────────────────

export async function deactivate(): Promise<void> {
  await stopClient();
}