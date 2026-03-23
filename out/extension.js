"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const binaryManager_1 = require("./binaryManager");
const guides_1 = require("./guides");
const docsView_1 = require("./docsView");
const configReader_1 = require("./configReader");
const lspClient_1 = require("./lspClient");
// ─── Module-level singletons ───────────────────────────────────────────────
let outputChannel;
let storageDir;
let statusBarItem;
const decorationsByUri = new Map();
const tokensByUri = new Map();
// ─── Status bar ────────────────────────────────────────────────────────────
function setStatus(text, tooltip, command) {
    statusBarItem.text = `$(symbol-function) ${text}`;
    statusBarItem.tooltip = tooltip ?? 'ForgeLSP';
    statusBarItem.command = command ?? 'forgescript.showStatus';
    statusBarItem.show();
}
// ─── Start / stop helpers ──────────────────────────────────────────────────
async function doStart() {
    setStatus('ForgeLSP: Starting…');
    try {
        const state = await (0, binaryManager_1.ensureBinary)(storageDir, outputChannel);
        const configPath = (0, configReader_1.findForgeConfig)();
        const initOptions = configPath
            ? (0, configReader_1.readForgeConfig)(configPath, outputChannel)
            : null;
        if (!configPath) {
            outputChannel.appendLine('[ForgeLSP] No forgeconfig.json found in workspace root.');
        }
        const client = (0, lspClient_1.createClient)(state.binaryPath, initOptions, outputChannel, storageDir);
        registerNotificationListeners(client);
        await (0, lspClient_1.startClient)(client);
        const tag = state.isCustom
            ? 'custom'
            : (state.installedTag ?? 'unknown');
        setStatus(`ForgeLSP: Running (${tag})`, `ForgeLSP is active. Binary: ${state.binaryPath}`, 'forgescript.showStatus');
        outputChannel.appendLine(`[ForgeLSP] Server started. Binary: ${state.binaryPath}`);
        // Re-apply decorations to all visible editors once client starts
        vscode.window.visibleTextEditors.forEach(editor => applyDecorations(editor));
    }
    catch (err) {
        setStatus('ForgeLSP: Error', `${err}`, 'forgescript.openLog');
        outputChannel.appendLine(`[ForgeLSP] ✗ Failed to start: ${err}`);
        vscode.window.showErrorMessage(`ForgeLSP: Failed to start — ${err}`);
    }
}
async function doStop() {
    setStatus('ForgeLSP: Stopping…');
    await (0, lspClient_1.stopClient)();
    clearAllDecorations();
    tokensByUri.clear();
    setStatus('ForgeLSP: Stopped', 'ForgeLSP server is not running.', 'forgescript.start');
    outputChannel.appendLine('[ForgeLSP] Server stopped.');
}
async function doRestart() {
    outputChannel.appendLine('[ForgeLSP] Restarting …');
    await doStop();
    await doStart();
}
// ─── Auto-update background check ─────────────────────────────────────────
async function backgroundUpdateCheck() {
    try {
        const release = await (0, binaryManager_1.checkForUpdate)(storageDir);
        if (!release)
            return;
        const choice = await vscode.window.showInformationMessage(`ForgeLSP: Update available — ${release.tag}. Install now?`, 'Update', 'Later');
        if (choice !== 'Update')
            return;
        outputChannel.appendLine(`[ForgeLSP] Auto-updating to ${release.tag} …`);
        await doStop();
        await (0, binaryManager_1.forceUpdate)(storageDir, outputChannel);
        await doStart();
        vscode.window.showInformationMessage(`ForgeLSP updated to ${release.tag}`);
    }
    catch (err) {
        // Silent failure — don't interrupt the user for update checks
        outputChannel.appendLine(`[ForgeLSP] Update check failed: ${err}`);
    }
}
// ─── Extension activate ────────────────────────────────────────────────────
async function activate(context) {
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
    context.subscriptions.push(vscode.commands.registerCommand('forgescript.start', async () => {
        if ((0, lspClient_1.isRunning)()) {
            vscode.window.showInformationMessage('ForgeLSP is already running.');
            return;
        }
        await doStart();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('forgescript.stop', async () => {
        if (!(0, lspClient_1.isRunning)()) {
            vscode.window.showInformationMessage('ForgeLSP is not running.');
            return;
        }
        await doStop();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('forgescript.restart', async () => {
        await doRestart();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('forgescript.forceUpdate', async () => {
        const confirm = await vscode.window.showWarningMessage('ForgeLSP: This will download and replace the current binary. Continue?', { modal: true }, 'Update');
        if (confirm !== 'Update')
            return;
        try {
            setStatus('ForgeLSP: Updating…');
            const wasRunning = (0, lspClient_1.isRunning)();
            if (wasRunning)
                await doStop();
            await (0, binaryManager_1.forceUpdate)(storageDir, outputChannel);
            if (wasRunning)
                await doStart();
            const state = (0, binaryManager_1.loadState)(storageDir);
            vscode.window.showInformationMessage(`ForgeLSP binary updated to ${state.installedTag ?? 'latest'}.`);
        }
        catch (err) {
            outputChannel.appendLine(`[ForgeLSP] Force-update failed: ${err}`);
            vscode.window.showErrorMessage(`ForgeLSP update failed: ${err}`);
            setStatus('ForgeLSP: Update failed', `${err}`, 'forgescript.openLog');
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('forgescript.checkForUpdates', async () => {
        try {
            vscode.window.showInformationMessage('ForgeLSP: Checking for updates…');
            const release = await (0, binaryManager_1.checkForUpdate)(storageDir);
            if (!release) {
                vscode.window.showInformationMessage('ForgeLSP: Already up to date.');
                return;
            }
            const choice = await vscode.window.showInformationMessage(`ForgeLSP update available: ${release.tag}`, 'Update Now', 'Later');
            if (choice === 'Update Now') {
                await vscode.commands.executeCommand('forgescript.forceUpdate');
            }
        }
        catch (err) {
            outputChannel.appendLine(`[ForgeLSP] Check-for-updates failed: ${err}`);
            vscode.window.showErrorMessage(`ForgeLSP: Could not check for updates — ${err}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('forgescript.setCustomBinary', async () => {
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
        if (!uris || uris.length === 0)
            return;
        const binaryPath = uris[0].fsPath;
        const err = (0, binaryManager_1.setCustomBinary)(storageDir, binaryPath);
        if (err) {
            vscode.window.showErrorMessage(`ForgeLSP: ${err}`);
            return;
        }
        outputChannel.appendLine(`[ForgeLSP] Custom binary set: ${binaryPath}`);
        vscode.window.showInformationMessage(`ForgeLSP custom binary set: ${binaryPath}. Restarting…`);
        await doRestart();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('forgescript.resetBinary', async () => {
        const state = (0, binaryManager_1.loadState)(storageDir);
        if (!state.isCustom) {
            vscode.window.showInformationMessage('ForgeLSP: Already using the official binary.');
            return;
        }
        (0, binaryManager_1.resetBinary)(storageDir);
        outputChannel.appendLine('[ForgeLSP] Reset to official binary.');
        const isWindows = process.platform === 'win32';
        const officialPath = path.join(storageDir, isWindows ? 'forgescript.exe' : 'ForgeLSP');
        const officialExists = require('fs').existsSync(officialPath);
        if (!officialExists) {
            const choice = await vscode.window.showInformationMessage('ForgeLSP: Official binary not present. Download it now?', 'Download', 'Cancel');
            if (choice !== 'Download')
                return;
        }
        await doRestart();
        vscode.window.showInformationMessage('ForgeLSP: Reset to official binary.');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('forgescript.showVersion', async () => {
        const state = (0, binaryManager_1.loadState)(storageDir);
        let latestTag = 'unknown';
        try {
            const release = await (0, binaryManager_1.fetchLatestRelease)();
            latestTag = release.tag;
        }
        catch {
            latestTag = '(could not fetch)';
        }
        if (state.isCustom) {
            vscode.window.showInformationMessage(`ForgeLSP: Using CUSTOM binary\nPath: ${state.binaryPath}\nLatest official: ${latestTag}`);
        }
        else {
            vscode.window.showInformationMessage(`ForgeLSP installed: ${state.installedTag ?? 'unknown'}\nLatest available: ${latestTag}\nBinary: ${state.binaryPath}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('forgescript.showStatus', async () => {
        const state = (0, binaryManager_1.loadState)(storageDir);
        const running = (0, lspClient_1.isRunning)();
        const client = (0, lspClient_1.getClient)();
        const lines = [
            `Status:        ${running ? '✓ Running' : '✗ Stopped'}`,
            `Binary:        ${state.binaryPath || '(none)'}`,
            `Version:       ${state.isCustom ? 'custom' : (state.installedTag ?? 'unknown')}`,
            `Custom binary: ${state.isCustom ? 'Yes' : 'No'}`,
            `Storage dir:   ${storageDir}`,
            `Config:        ${(0, configReader_1.findForgeConfig)() ?? '(none)'}`,
        ];
        const panel = vscode.window.createOutputChannel('ForgeLSP Status');
        panel.clear();
        panel.appendLine('─── ForgeLSP Status ───────────────────────────');
        lines.forEach((l) => panel.appendLine(l));
        panel.appendLine('────────────────────────────────────────────────');
        panel.show(true);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('forgescript.openLog', () => {
        outputChannel.show();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('forgescript.reloadConfig', async () => {
        outputChannel.appendLine('[ForgeLSP] Reloading configuration…');
        await doRestart();
        vscode.window.showInformationMessage('ForgeLSP: Configuration reloaded.');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('forgescript.openConfig', async () => {
        await (0, configReader_1.openOrCreateForgeConfig)(outputChannel);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('forgescript.createConfig', async () => {
        await (0, configReader_1.openOrCreateForgeConfig)(outputChannel);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('forgevsc.search', async () => {
        await (0, docsView_1.runSearch)();
    }));
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
        if (editor)
            applyDecorations(editor);
    }));
    context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(editors => {
        editors.forEach(editor => applyDecorations(editor));
    }));
    // ── Guides sidebar ───────────────────────────────────────────────────────
    (0, guides_1.initGuides)(context);
    (0, docsView_1.registerDocsView)(context, outputChannel);
    // ── Initial start ─────────────────────────────────────────────────────────
    await doStart();
    // ── Background update check (after 10 s to not slow startup) ─────────────
    setTimeout(() => backgroundUpdateCheck(), 10000);
}
// ─── Helpers for Notifications & Decorations ────────────────────────────────
function clearAllDecorations() {
    for (const decorations of decorationsByUri.values()) {
        decorations.forEach(d => d.dispose());
    }
    decorationsByUri.clear();
}
function applyDecorations(editor) {
    const uri = editor.document.uri.toString();
    const tokens = tokensByUri.get(uri);
    if (!tokens)
        return;
    const configPath = (0, configReader_1.findForgeConfig)();
    if (!configPath)
        return;
    const config = (0, configReader_1.readForgeConfig)(configPath, outputChannel);
    if (!config || !config.customColors || config.customColors.length === 0) {
        // Clear existing decorations if custom colors are disabled or missing
        const existing = decorationsByUri.get(uri);
        if (existing) {
            existing.forEach(d => d.dispose());
            decorationsByUri.delete(uri);
        }
        return;
    }
    const colors = config.customColors;
    // Clear existing decorations for this URI before applying new ones
    const existing = decorationsByUri.get(uri);
    if (existing) {
        existing.forEach(d => d.dispose());
    }
    const newDecorations = colors.map(c => vscode.window.createTextEditorDecorationType({
        color: c
    }));
    const rangesByColorIndex = new Map();
    for (const token of tokens) {
        if (!rangesByColorIndex.has(token.color_index)) {
            rangesByColorIndex.set(token.color_index, []);
        }
        const range = new vscode.Range(token.range.start.line, token.range.start.character, token.range.end.line, token.range.end.character);
        rangesByColorIndex.get(token.color_index).push(range);
    }
    for (const [index, ranges] of rangesByColorIndex) {
        if (index < newDecorations.length) {
            editor.setDecorations(newDecorations[index], ranges);
        }
    }
    decorationsByUri.set(uri, newDecorations);
}
function registerNotificationListeners(client) {
    client.onNotification('forge/customColors', (params) => {
        tokensByUri.set(params.uri, params.tokens);
        const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === params.uri);
        if (editor) {
            applyDecorations(editor);
        }
    });
}
// ─── Extension deactivate ──────────────────────────────────────────────────
async function deactivate() {
    await (0, lspClient_1.stopClient)();
}
//# sourceMappingURL=extension.js.map