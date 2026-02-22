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
const configReader_1 = require("./configReader");
const lspClient_1 = require("./lspClient");
// ─── Module-level singletons ───────────────────────────────────────────────
let outputChannel;
let storageDir;
let statusBarItem;
// ─── Status bar ────────────────────────────────────────────────────────────
function setStatus(text, tooltip, command) {
    statusBarItem.text = `$(symbol-function) ${text}`;
    statusBarItem.tooltip = tooltip ?? 'ForgeLSP';
    statusBarItem.command = command ?? 'forgescript.showStatus';
    statusBarItem.show();
}
let statsInterval;
function startStatsPolling() {
    stopStatsPolling();
    statsInterval = setInterval(async () => {
        if (!(0, lspClient_1.isRunning)())
            return;
        const client = (0, lspClient_1.getClient)();
        if (!client)
            return;
        try {
            const activeEditor = vscode.window.activeTextEditor;
            const uri = activeEditor ? activeEditor.document.uri.toString() : undefined;
            const args = uri ? [uri] : [];
            const stats = await client.sendRequest('workspace/executeCommand', {
                command: 'forgescript.getStats',
                arguments: args
            });
            if (stats) {
                const md = new vscode.MarkdownString();
                md.isTrusted = true;
                md.appendMarkdown(`**ForgeLSP is active.**\n\n`);
                md.appendMarkdown(`- **Average Parse Time**: ${stats.averageParseTime.toFixed(2)}ms\n`);
                md.appendMarkdown(`- **Current File Average Parse Time**: ${stats.currentFileParseTime.toFixed(2)}ms\n`);
                md.appendMarkdown(`- **Lowest Parse Time**: ${stats.lowestParseTime.toFixed(2)}ms\n`);
                md.appendMarkdown(`- **Total Parses**: ${stats.totalParses}\n\n`);
                md.appendMarkdown(`---\n\n`);
                md.appendMarkdown(`[$(refresh) Restart](command:forgescript.restart)  |  `);
                md.appendMarkdown(`[$(stop) Stop](command:forgescript.stop)\n\n`);
                md.appendMarkdown(`[$(trash) Remove Cache](command:forgescript.removeCache)  |  `);
                md.appendMarkdown(`[$(sync) Refetch Metadata](command:forgescript.refetchMetadata)`);
                statusBarItem.tooltip = md;
            }
        }
        catch (e) {
            // ignore
        }
    }, 2000);
}
function stopStatsPolling() {
    if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = undefined;
    }
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
        await (0, lspClient_1.startClient)(client);
        const tag = state.isCustom
            ? 'custom'
            : (state.installedTag ?? 'unknown');
        setStatus(`ForgeLSP: Running (${tag})`, `ForgeLSP is active. Binary: ${state.binaryPath}`, 'forgescript.showStatus');
        outputChannel.appendLine(`[ForgeLSP] Server started. Binary: ${state.binaryPath}`);
        startStatsPolling();
    }
    catch (err) {
        setStatus('ForgeLSP: Error', `${err}`, 'forgescript.openLog');
        outputChannel.appendLine(`[ForgeLSP] ✗ Failed to start: ${err}`);
        vscode.window.showErrorMessage(`ForgeLSP: Failed to start — ${err}`);
    }
}
async function doStop() {
    stopStatsPolling();
    setStatus('ForgeLSP: Stopping…');
    await (0, lspClient_1.stopClient)();
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
    context.subscriptions.push(vscode.commands.registerCommand('forgescript.removeCache', async () => {
        const client = (0, lspClient_1.getClient)();
        if (client && (0, lspClient_1.isRunning)()) {
            await client.sendRequest('workspace/executeCommand', {
                command: 'forgescript.removeCache',
                arguments: []
            });
            vscode.window.showInformationMessage('ForgeLSP: Parse cache removed.');
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('forgescript.refetchMetadata', async () => {
        const client = (0, lspClient_1.getClient)();
        if (client && (0, lspClient_1.isRunning)()) {
            vscode.window.showInformationMessage('ForgeLSP: Refetching metadata...');
            await client.sendRequest('workspace/executeCommand', {
                command: 'forgescript.refetchMetadata',
                arguments: []
            });
            vscode.window.showInformationMessage('ForgeLSP: Metadata refetched successfully.');
        }
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
    // ── Initial start ─────────────────────────────────────────────────────────
    await doStart();
    // ── Background update check (after 10 s to not slow startup) ─────────────
    setTimeout(() => backgroundUpdateCheck(), 10000);
}
// ─── Extension deactivate ──────────────────────────────────────────────────
async function deactivate() {
    await (0, lspClient_1.stopClient)();
}
//# sourceMappingURL=extension.js.map