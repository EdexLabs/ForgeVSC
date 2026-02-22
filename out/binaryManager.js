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
exports.getPlatformAssetName = getPlatformAssetName;
exports.loadState = loadState;
exports.fetchLatestRelease = fetchLatestRelease;
exports.installBinary = installBinary;
exports.ensureBinary = ensureBinary;
exports.forceUpdate = forceUpdate;
exports.checkForUpdate = checkForUpdate;
exports.setCustomBinary = setCustomBinary;
exports.resetBinary = resetBinary;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const https = __importStar(require("https"));
const crypto = __importStar(require("crypto"));
const fs_1 = require("fs");
const GITHUB_REPO = 'EdexLabs/ForgeLSP';
const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const USER_AGENT = 'vscode-forgelsp/1.0';
// ─── Platform detection ────────────────────────────────────────────────────
function getPlatformAssetName() {
    const platform = process.platform;
    const arch = process.arch;
    if (platform === 'linux' && arch === 'arm64')
        return 'ForgeLSP-linux-aarch64';
    if (platform === 'linux')
        return 'ForgeLSP-linux-x86_64';
    if (platform === 'darwin' && arch === 'arm64')
        return 'ForgeLSP-macos-aarch64';
    if (platform === 'darwin')
        return 'ForgeLSP-macos-x86_64';
    if (platform === 'win32')
        return 'ForgeLSP-windows-x86_64.exe';
    throw new Error(`Unsupported platform: ${platform} ${arch}`);
}
// ─── State persistence ─────────────────────────────────────────────────────
const STATE_FILE = 'binary-state.json';
function stateFilePath(storageDir) {
    return path.join(storageDir, STATE_FILE);
}
function loadState(storageDir) {
    const file = stateFilePath(storageDir);
    try {
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return { binaryPath: '', isCustom: false, installedTag: null };
    }
}
function saveState(storageDir, state) {
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(stateFilePath(storageDir), JSON.stringify(state, null, 2), 'utf8');
}
// ─── HTTP helpers ──────────────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, ...headers } }, (res) => {
            if (res.statusCode === 302 || res.statusCode === 301) {
                if (res.headers.location) {
                    resolve(httpsGet(res.headers.location, headers));
                    return;
                }
                reject(new Error(`Redirect with no location header (${res.statusCode})`));
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                return;
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', reject);
        });
        req.on('error', reject);
    });
}
function downloadFile(url, dest, progress) {
    return new Promise((resolve, reject) => {
        const follow = (u) => {
            const req = https.get(u, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
                if (res.statusCode === 302 || res.statusCode === 301) {
                    if (res.headers.location) {
                        follow(res.headers.location);
                        return;
                    }
                    reject(new Error('Redirect with no location'));
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                const total = parseInt(res.headers['content-length'] ?? '0', 10);
                let received = 0;
                const out = (0, fs_1.createWriteStream)(dest);
                res.on('data', (chunk) => {
                    received += chunk.length;
                    if (total > 0 && progress) {
                        progress(Math.round((received / total) * 100));
                    }
                });
                res.pipe(out);
                out.on('finish', () => out.close(() => resolve()));
                out.on('error', reject);
                res.on('error', reject);
            });
            req.on('error', reject);
        };
        follow(url);
    });
}
// ─── Checksum parsing ──────────────────────────────────────────────────────
/**
 * Tries to extract sha256 checksums from the GitHub release body text.
 * Falls back to the hardcoded KNOWN_CHECKSUMS map.
 *
 * Expected format in release body:
 *   sha256:aaabbb  or  sha256:aaabbb\nfilename
 */
function parseChecksumsFromBody(body) {
    const result = {};
    // Match lines like: * ForgeLSP-linux-x86_64\nsha256:hexhex
    const assetPattern = /\*\s*(ForgeLSP-[^\n]+)\s*\nsha256:([a-fA-F0-9]{64})/g;
    let match;
    while ((match = assetPattern.exec(body)) !== null) {
        result[match[1].trim()] = match[2].trim();
    }
    return result;
}
// ─── GitHub release fetching ───────────────────────────────────────────────
/**
 * Fetches latest GitHub release metadata and extracts:
 *  - correct platform asset
 *  - checksum file (if present)
 */
async function fetchLatestRelease() {
    const body = await httpsGet(RELEASES_API_URL);
    const release = JSON.parse(body);
    const tag = release.tag_name ?? 'unknown';
    const assetName = getPlatformAssetName();
    const assets = release.assets ?? [];
    const binaryAsset = assets.find(a => a.name === assetName);
    if (!binaryAsset) {
        throw new Error(`No asset named "${assetName}" found in release ${tag}.`);
    }
    // Look for a checksum file in release assets
    const checksumAsset = assets.find(a => a.name.toLowerCase().includes('checksum'));
    let checksums = {};
    if (checksumAsset) {
        const checksumBody = await httpsGet(checksumAsset.browser_download_url);
        checksums = parseChecksumFile(checksumBody);
    }
    return {
        tag,
        assetName,
        downloadUrl: binaryAsset.browser_download_url,
        checksums,
    };
}
function parseChecksumFile(text) {
    const result = {};
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(trimmed);
        if (!match)
            continue;
        const [, hash, filename] = match;
        result[filename.trim()] = hash.toLowerCase();
    }
    return result;
}
// ─── SHA256 verification ───────────────────────────────────────────────────
async function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (d) => hash.update(d));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}
// ─── Install / update ──────────────────────────────────────────────────────
async function installBinary(storageDir, release, outputChannel) {
    fs.mkdirSync(storageDir, { recursive: true });
    const isWindows = process.platform === 'win32';
    const destName = isWindows ? 'ForgeLSP.exe' : 'ForgeLSP';
    const destPath = path.join(storageDir, destName);
    const tmpPath = destPath + '.tmp';
    outputChannel.appendLine(`[ForgeLSP] Downloading ${release.assetName} @ ${release.tag} …`);
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `ForgeLSP: Downloading binary ${release.tag}`,
        cancellable: false,
    }, async (progress) => {
        let last = 0;
        await downloadFile(release.downloadUrl, tmpPath, (pct) => {
            progress.report({ increment: pct - last, message: `${pct}%` });
            last = pct;
        });
    });
    outputChannel.appendLine('[ForgeLSP] Verifying checksum …');
    const actual = await sha256File(tmpPath);
    const expected = release.checksums[release.assetName];
    if (expected && actual.toLowerCase() !== expected.toLowerCase()) {
        fs.unlinkSync(tmpPath);
        throw new Error(`SHA256 mismatch for ${release.assetName}!\n  expected: ${expected}\n  actual:   ${actual}`);
    }
    else if (!expected) {
        outputChannel.appendLine('[ForgeLSP] ⚠ No known checksum to verify against — skipping.');
    }
    else {
        outputChannel.appendLine('[ForgeLSP] ✓ Checksum OK');
    }
    // Atomically replace
    if (fs.existsSync(destPath))
        fs.unlinkSync(destPath);
    fs.renameSync(tmpPath, destPath);
    if (!isWindows) {
        fs.chmodSync(destPath, 0o755);
    }
    outputChannel.appendLine(`[ForgeLSP] Binary installed: ${destPath}`);
    return destPath;
}
// ─── Public API ────────────────────────────────────────────────────────────
/**
 * Returns the path to a ready-to-use binary, downloading it if necessary.
 * Mutates and persists BinaryState.
 */
async function ensureBinary(storageDir, outputChannel) {
    let state = loadState(storageDir);
    // User has pinned a custom binary — verify it still exists
    if (state.isCustom) {
        if (fs.existsSync(state.binaryPath)) {
            outputChannel.appendLine(`[ForgeLSP] Using custom binary: ${state.binaryPath}`);
            return state;
        }
        outputChannel.appendLine('[ForgeLSP] ⚠ Custom binary not found, falling back to official.');
        state.isCustom = false;
    }
    // Official binary — check if it exists
    const isWindows = process.platform === 'win32';
    const officialPath = path.join(storageDir, isWindows ? 'ForgeLSP.exe' : 'ForgeLSP');
    if (!fs.existsSync(officialPath)) {
        outputChannel.appendLine('[ForgeLSP] Binary not found — downloading …');
        const release = await fetchLatestRelease();
        const binaryPath = await installBinary(storageDir, release, outputChannel);
        state = { binaryPath, isCustom: false, installedTag: release.tag };
        saveState(storageDir, state);
        return state;
    }
    state.binaryPath = officialPath;
    saveState(storageDir, state);
    return state;
}
/**
 * Forces a fresh download of the latest official binary regardless of current state.
 */
async function forceUpdate(storageDir, outputChannel) {
    outputChannel.appendLine('[ForgeLSP] Force-updating binary …');
    const release = await fetchLatestRelease();
    const binaryPath = await installBinary(storageDir, release, outputChannel);
    const state = { binaryPath, isCustom: false, installedTag: release.tag };
    saveState(storageDir, state);
    return state;
}
/**
 * Checks GitHub for a newer release tag. Returns the release if an update
 * is available, otherwise null.
 */
async function checkForUpdate(storageDir) {
    const state = loadState(storageDir);
    if (state.isCustom)
        return null;
    const release = await fetchLatestRelease();
    if (release.tag !== state.installedTag) {
        return release;
    }
    return null;
}
/**
 * Pins a user-supplied binary path. Returns an error string or null on success.
 */
function setCustomBinary(storageDir, binaryPath) {
    if (!fs.existsSync(binaryPath)) {
        return `File not found: ${binaryPath}`;
    }
    const stat = fs.statSync(binaryPath);
    if (!stat.isFile()) {
        return `Not a file: ${binaryPath}`;
    }
    if (process.platform !== 'win32') {
        try {
            fs.accessSync(binaryPath, fs.constants.X_OK);
        }
        catch {
            return `File is not executable: ${binaryPath}`;
        }
    }
    const state = {
        binaryPath,
        isCustom: true,
        installedTag: null,
    };
    saveState(storageDir, state);
    return null;
}
/**
 * Clears the custom binary pin, returning to the official binary.
 */
function resetBinary(storageDir) {
    const state = loadState(storageDir);
    state.isCustom = false;
    const isWindows = process.platform === 'win32';
    state.binaryPath = path.join(storageDir, isWindows ? 'ForgeLSP.exe' : 'ForgeLSP');
    saveState(storageDir, state);
}
//# sourceMappingURL=binaryManager.js.map