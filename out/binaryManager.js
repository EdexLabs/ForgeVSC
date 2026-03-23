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
    try {
        const raw = fs.readFileSync(stateFilePath(storageDir), 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return { binaryPath: '', isCustom: false, installedReleaseId: null };
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
                if (res.headers.location)
                    return resolve(httpsGet(res.headers.location, headers));
                return reject(new Error(`Redirect with no location header (${res.statusCode})`));
            }
            if (res.statusCode !== 200)
                return reject(new Error(`HTTP ${res.statusCode}`));
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
            https.get(u, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
                if (res.statusCode === 302 || res.statusCode === 301) {
                    if (res.headers.location)
                        return follow(res.headers.location);
                    return reject(new Error('Redirect with no location'));
                }
                if (res.statusCode !== 200)
                    return reject(new Error(`HTTP ${res.statusCode}`));
                const total = parseInt(res.headers['content-length'] ?? '0', 10);
                let received = 0;
                const out = (0, fs_1.createWriteStream)(dest);
                res.on('data', (chunk) => {
                    received += chunk.length;
                    if (total && progress)
                        progress(Math.round((received / total) * 100));
                });
                res.pipe(out);
                out.on('finish', () => out.close(() => resolve()));
                out.on('error', reject);
                res.on('error', reject);
            }).on('error', reject);
        };
        follow(url);
    });
}
// ─── Checksum parsing ──────────────────────────────────────────────────────
function parseChecksumsFromBody(body) {
    const result = {};
    const pattern = /\*\s*(ForgeLSP-[^\n]+)\s*\nsha256:([a-fA-F0-9]{64})/g;
    let match;
    while ((match = pattern.exec(body)) !== null) {
        result[match[1].trim()] = match[2].toLowerCase();
    }
    return result;
}
function parseChecksumFile(text) {
    const result = {};
    for (const line of text.split(/\r?\n/)) {
        const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
        if (match)
            result[match[2].trim()] = match[1].toLowerCase();
    }
    return result;
}
// ─── GitHub release fetching ───────────────────────────────────────────────
async function fetchLatestRelease() {
    const body = await httpsGet(RELEASES_API_URL);
    const release = JSON.parse(body);
    const assetName = getPlatformAssetName();
    const assets = release.assets ?? [];
    const binaryAsset = assets.find(a => a.name === assetName);
    if (!binaryAsset)
        throw new Error(`Missing asset: ${assetName}`);
    const checksumAsset = assets.find(a => a.name.toLowerCase().includes('checksum'));
    let checksums = {};
    // 1. Try checksum file
    if (checksumAsset) {
        const text = await httpsGet(checksumAsset.browser_download_url);
        checksums = parseChecksumFile(text);
    }
    // 2. Fallback to release body
    if (Object.keys(checksums).length === 0 && release.body) {
        checksums = parseChecksumsFromBody(release.body);
    }
    return {
        tag: release.tag_name ?? 'unknown',
        id: release.id,
        assetName,
        downloadUrl: binaryAsset.browser_download_url,
        checksums,
    };
}
// ─── SHA256 verification ───────────────────────────────────────────────────
async function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(filePath)
            .on('data', d => hash.update(d))
            .on('end', () => resolve(hash.digest('hex')))
            .on('error', reject);
    });
}
// ─── Install ───────────────────────────────────────────────────────────────
async function installBinary(storageDir, release, outputChannel) {
    fs.mkdirSync(storageDir, { recursive: true });
    const dest = path.join(storageDir, process.platform === 'win32' ? 'ForgeLSP.exe' : 'ForgeLSP');
    const tmp = dest + '.tmp';
    outputChannel.appendLine(`[ForgeLSP] Downloading ${release.assetName} @ ${release.tag}`);
    await downloadFile(release.downloadUrl, tmp);
    const actual = await sha256File(tmp);
    const expected = release.checksums[release.assetName];
    if (expected && actual !== expected) {
        fs.unlinkSync(tmp);
        throw new Error(`Checksum mismatch\nexpected: ${expected}\nactual: ${actual}`);
    }
    if (!expected) {
        outputChannel.appendLine('[ForgeLSP] ⚠ No checksum available');
    }
    if (fs.existsSync(dest))
        fs.unlinkSync(dest);
    fs.renameSync(tmp, dest);
    if (process.platform !== 'win32')
        fs.chmodSync(dest, 0o755);
    return dest;
}
// ─── Public API ────────────────────────────────────────────────────────────
async function ensureBinary(storageDir, out) {
    let state = loadState(storageDir);
    if (state.isCustom && fs.existsSync(state.binaryPath))
        return state;
    const dest = path.join(storageDir, process.platform === 'win32' ? 'ForgeLSP.exe' : 'ForgeLSP');
    if (!fs.existsSync(dest)) {
        const release = await fetchLatestRelease();
        const binaryPath = await installBinary(storageDir, release, out);
        state = {
            binaryPath,
            isCustom: false,
            installedReleaseId: release.id
        };
        saveState(storageDir, state);
        return state;
    }
    state.binaryPath = dest;
    saveState(storageDir, state);
    return state;
}
async function forceUpdate(storageDir, out) {
    const release = await fetchLatestRelease();
    const binaryPath = await installBinary(storageDir, release, out);
    const state = {
        binaryPath,
        isCustom: false,
        installedReleaseId: release.id
    };
    saveState(storageDir, state);
    return state;
}
async function checkForUpdate(storageDir) {
    const state = loadState(storageDir);
    if (state.isCustom)
        return null;
    const release = await fetchLatestRelease();
    if (release.id !== state.installedReleaseId) {
        return release;
    }
    return null;
}
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
        installedReleaseId: null,
    };
    saveState(storageDir, state);
    return null;
}
function resetBinary(storageDir) {
    const state = loadState(storageDir);
    state.isCustom = false;
    const isWindows = process.platform === 'win32';
    state.binaryPath = path.join(storageDir, isWindows ? 'ForgeLSP.exe' : 'ForgeLSP');
    state.installedReleaseId = null;
    saveState(storageDir, state);
}
//# sourceMappingURL=binaryManager.js.map