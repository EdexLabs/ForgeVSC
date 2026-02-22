import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as crypto from 'crypto';
import { createWriteStream } from 'fs';

const GITHUB_REPO = 'EdexLabs/ForgeLSP';
const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const USER_AGENT = 'vscode-forgelsp/1.0';

export interface ReleaseInfo {
  tag: string;
  assetName: string;
  downloadUrl: string;
  checksums: Record<string, string>;
}

export interface BinaryState {
  /** Absolute path to the binary that should be launched. */
  binaryPath: string;
  /** Whether the user has pinned a custom binary path. */
  isCustom: boolean;
  /** Tag of the installed official binary, e.g. "v1.2.3". */
  installedTag: string | null;
}

// ─── Platform detection ────────────────────────────────────────────────────

export function getPlatformAssetName(): string {
  const platform = process.platform;
  const arch     = process.arch;

  if (platform === 'linux' && arch === 'arm64')  return 'ForgeLSP-linux-aarch64';
  if (platform === 'linux')                       return 'ForgeLSP-linux-x86_64';
  if (platform === 'darwin' && arch === 'arm64')  return 'ForgeLSP-macos-aarch64';
  if (platform === 'darwin')                      return 'ForgeLSP-macos-x86_64';
  if (platform === 'win32')                       return 'ForgeLSP-windows-x86_64.exe';

  throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

// ─── State persistence ─────────────────────────────────────────────────────

const STATE_FILE = 'binary-state.json';

function stateFilePath(storageDir: string): string {
  return path.join(storageDir, STATE_FILE);
}

export function loadState(storageDir: string): BinaryState {
  const file = stateFilePath(storageDir);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as BinaryState;
  } catch {
    return { binaryPath: '', isCustom: false, installedTag: null };
  }
}

function saveState(storageDir: string, state: BinaryState): void {
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(stateFilePath(storageDir), JSON.stringify(state, null, 2), 'utf8');
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

function httpsGet(url: string, headers: Record<string, string> = {}): Promise<string> {
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
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function downloadFile(url: string, dest: string, progress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (u: string) => {
      const req = https.get(u, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          if (res.headers.location) { follow(res.headers.location); return; }
          reject(new Error('Redirect with no location')); return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`)); return;
        }

        const total = parseInt(res.headers['content-length'] ?? '0', 10);
        let received = 0;
        const out = createWriteStream(dest);

        res.on('data', (chunk: Buffer) => {
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
function parseChecksumsFromBody(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Match lines like: * ForgeLSP-linux-x86_64\nsha256:hexhex
  const assetPattern = /\*\s*(ForgeLSP-[^\n]+)\s*\nsha256:([a-fA-F0-9]{64})/g;
  let match: RegExpExecArray | null;
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
export async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const body = await httpsGet(RELEASES_API_URL);
  const release = JSON.parse(body);

  const tag: string = release.tag_name ?? 'unknown';
  const assetName = getPlatformAssetName();

  const assets: any[] = release.assets ?? [];

  const binaryAsset = assets.find(a => a.name === assetName);
  if (!binaryAsset) {
    throw new Error(
      `No asset named "${assetName}" found in release ${tag}.`
    );
  }

  // Look for a checksum file in release assets
  const checksumAsset = assets.find(a =>
    a.name.toLowerCase().includes('checksum')
  );

  let checksums: Record<string, string> = {};

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

function parseChecksumFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};

  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(trimmed);
    if (!match) continue;

    const [, hash, filename] = match;
    result[filename.trim()] = hash.toLowerCase();
  }

  return result;
}

// ─── SHA256 verification ───────────────────────────────────────────────────

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end',  () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ─── Install / update ──────────────────────────────────────────────────────

export async function installBinary(
  storageDir: string,
  release: ReleaseInfo,
  outputChannel: vscode.OutputChannel
): Promise<string> {
  fs.mkdirSync(storageDir, { recursive: true });

  const isWindows = process.platform === 'win32';
  const destName  = isWindows ? 'ForgeLSP.exe' : 'ForgeLSP';
  const destPath  = path.join(storageDir, destName);
  const tmpPath   = destPath + '.tmp';

  outputChannel.appendLine(`[ForgeLSP] Downloading ${release.assetName} @ ${release.tag} …`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `ForgeLSP: Downloading binary ${release.tag}`,
      cancellable: false,
    },
    async (progress) => {
      let last = 0;
      await downloadFile(release.downloadUrl, tmpPath, (pct) => {
        progress.report({ increment: pct - last, message: `${pct}%` });
        last = pct;
      });
    }
  );

  outputChannel.appendLine('[ForgeLSP] Verifying checksum …');
  const actual   = await sha256File(tmpPath);
  const expected = release.checksums[release.assetName];

  if (expected && actual.toLowerCase() !== expected.toLowerCase()) {
    fs.unlinkSync(tmpPath);
    throw new Error(
      `SHA256 mismatch for ${release.assetName}!\n  expected: ${expected}\n  actual:   ${actual}`
    );
  } else if (!expected) {
    outputChannel.appendLine('[ForgeLSP] ⚠ No known checksum to verify against — skipping.');
  } else {
    outputChannel.appendLine('[ForgeLSP] ✓ Checksum OK');
  }

  // Atomically replace
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
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
export async function ensureBinary(
  storageDir: string,
  outputChannel: vscode.OutputChannel
): Promise<BinaryState> {
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
export async function forceUpdate(
  storageDir: string,
  outputChannel: vscode.OutputChannel
): Promise<BinaryState> {
  outputChannel.appendLine('[ForgeLSP] Force-updating binary …');
  const release = await fetchLatestRelease();
  const binaryPath = await installBinary(storageDir, release, outputChannel);
  const state: BinaryState = { binaryPath, isCustom: false, installedTag: release.tag };
  saveState(storageDir, state);
  return state;
}

/**
 * Checks GitHub for a newer release tag. Returns the release if an update
 * is available, otherwise null.
 */
export async function checkForUpdate(
  storageDir: string
): Promise<ReleaseInfo | null> {
  const state = loadState(storageDir);
  if (state.isCustom) return null;

  const release = await fetchLatestRelease();
  if (release.tag !== state.installedTag) {
    return release;
  }
  return null;
}

/**
 * Pins a user-supplied binary path. Returns an error string or null on success.
 */
export function setCustomBinary(
  storageDir: string,
  binaryPath: string
): string | null {
  if (!fs.existsSync(binaryPath)) {
    return `File not found: ${binaryPath}`;
  }
  const stat = fs.statSync(binaryPath);
  if (!stat.isFile()) {
    return `Not a file: ${binaryPath}`;
  }
  if (process.platform !== 'win32') {
    try { fs.accessSync(binaryPath, fs.constants.X_OK); }
    catch { return `File is not executable: ${binaryPath}`; }
  }

  const state: BinaryState = {
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
export function resetBinary(storageDir: string): void {
  const state = loadState(storageDir);
  state.isCustom = false;
  const isWindows = process.platform === 'win32';
  state.binaryPath = path.join(storageDir, isWindows ? 'ForgeLSP.exe' : 'ForgeLSP');
  saveState(storageDir, state);
}
