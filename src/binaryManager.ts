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
  id: number;
  assetName: string;
  downloadUrl: string;
  checksums: Record<string, string>;
}

export interface BinaryState {
  binaryPath: string;
  isCustom: boolean;
  /** Stores release.id instead of tag */
  installedReleaseId: number | null;
}

// ─── Platform detection ────────────────────────────────────────────────────

export function getPlatformAssetName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'linux' && arch === 'arm64') return 'ForgeLSP-linux-aarch64';
  if (platform === 'linux') return 'ForgeLSP-linux-x86_64';
  if (platform === 'darwin' && arch === 'arm64') return 'ForgeLSP-macos-aarch64';
  if (platform === 'darwin') return 'ForgeLSP-macos-x86_64';
  if (platform === 'win32') return 'ForgeLSP-windows-x86_64.exe';

  throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

// ─── State persistence ─────────────────────────────────────────────────────

const STATE_FILE = 'binary-state.json';

function stateFilePath(storageDir: string): string {
  return path.join(storageDir, STATE_FILE);
}

export function loadState(storageDir: string): BinaryState {
  try {
    const raw = fs.readFileSync(stateFilePath(storageDir), 'utf8');
    return JSON.parse(raw) as BinaryState;
  } catch {
    return { binaryPath: '', isCustom: false, installedReleaseId: null };
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
        if (res.headers.location) return resolve(httpsGet(res.headers.location, headers));
        return reject(new Error(`Redirect with no location header (${res.statusCode})`));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

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
      https.get(u, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          if (res.headers.location) return follow(res.headers.location);
          return reject(new Error('Redirect with no location'));
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

        const total = parseInt(res.headers['content-length'] ?? '0', 10);
        let received = 0;
        const out = createWriteStream(dest);

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (total && progress) progress(Math.round((received / total) * 100));
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

function parseChecksumsFromBody(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /\*\s*(ForgeLSP-[^\n]+)\s*\nsha256:([a-fA-F0-9]{64})/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    result[match[1].trim()] = match[2].toLowerCase();
  }

  return result;
}

function parseChecksumFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match) result[match[2].trim()] = match[1].toLowerCase();
  }
  return result;
}

// ─── GitHub release fetching ───────────────────────────────────────────────

export async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const body = await httpsGet(RELEASES_API_URL);
  const release = JSON.parse(body);

  const assetName = getPlatformAssetName();
  const assets: any[] = release.assets ?? [];

  const binaryAsset = assets.find(a => a.name === assetName);
  if (!binaryAsset) throw new Error(`Missing asset: ${assetName}`);

  const checksumAsset = assets.find(a =>
    a.name.toLowerCase().includes('checksum')
  );

  let checksums: Record<string, string> = {};

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

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', d => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

// ─── Install ───────────────────────────────────────────────────────────────

export async function installBinary(
  storageDir: string,
  release: ReleaseInfo,
  outputChannel: vscode.OutputChannel
): Promise<string> {
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

  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  fs.renameSync(tmp, dest);

  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);

  return dest;
}

// ─── Public API ────────────────────────────────────────────────────────────

export async function ensureBinary(storageDir: string, out: vscode.OutputChannel): Promise<BinaryState> {
  let state = loadState(storageDir);

  if (state.isCustom && fs.existsSync(state.binaryPath)) return state;

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

export async function forceUpdate(storageDir: string, out: vscode.OutputChannel): Promise<BinaryState> {
  const release = await fetchLatestRelease();
  const binaryPath = await installBinary(storageDir, release, out);

  const state: BinaryState = {
    binaryPath,
    isCustom: false,
    installedReleaseId: release.id
  };

  saveState(storageDir, state);
  return state;
}

export async function checkForUpdate(storageDir: string): Promise<ReleaseInfo | null> {
  const state = loadState(storageDir);
  if (state.isCustom) return null;

  const release = await fetchLatestRelease();

  if (release.id !== state.installedReleaseId) {
    return release;
  }

  return null;
}

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
    try {
      fs.accessSync(binaryPath, fs.constants.X_OK);
    } catch {
      return `File is not executable: ${binaryPath}`;
    }
  }

  const state: BinaryState = {
    binaryPath,
    isCustom: true,
    installedReleaseId: null,
  };

  saveState(storageDir, state);
  return null;
}

export function resetBinary(storageDir: string): void {
  const state = loadState(storageDir);

  state.isCustom = false;

  const isWindows = process.platform === 'win32';
  state.binaryPath = path.join(
    storageDir,
    isWindows ? 'ForgeLSP.exe' : 'ForgeLSP'
  );

  state.installedReleaseId = null;

  saveState(storageDir, state);
}
