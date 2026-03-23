import * as vscode from 'vscode';
import * as https from 'https';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface GuideUser {
    id: number;
    username: string;
    discordId: string;
    role: string;
    Label: string;
    avatarUrl: string;
}

export interface GuideContributor extends GuideUser {
    isOriginalAuthor: boolean;
}

export interface GuideMetadata {
    id: number;
    referenceId: number;
    guideType: 'specific' | 'dedicated';
    packageName: string;
    targetType: 'function' | 'event' | 'enum' | 'none';
    targetName: string | null;
    title: string | null;
    category: string | null;
    subCategory: string | null;
    content: string;
    reviewerId: number;
    submittedAt: string;
    approvedAt: string;
    approver: GuideUser;
    contributors: GuideContributor[];
}

// ─── Constants ─────────────────────────────────────────────────────────────

const GUIDES_URL = 'https://raw.githubusercontent.com/tryforge/ForgeVSC/refs/heads/metadata/guides.json';
const CACHE_KEY = 'forgescript.guides.cache';
const FAVS_KEY = 'forgescript.guides.favorites';
export const DOCS_BASE = 'https://docs.botforge.org/';

// ─── Module state ──────────────────────────────────────────────────────────

let guideCtx: vscode.ExtensionContext;
let memCache: GuideMetadata[] | null = null;
let inflight: Promise<GuideMetadata[]> | null = null;

export function initGuides(ctx: vscode.ExtensionContext): void {
    guideCtx = ctx;
}

// ─── HTTP helper ───────────────────────────────────────────────────────────

function fetchJson<T>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const follow = (u: string) => {
            https.get(u, { headers: { 'User-Agent': 'ForgeScript/guides' } }, res => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    res.headers.location ? follow(res.headers.location) : reject(new Error('Redirect without location'));
                    return;
                }
                if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${u}`)); return; }
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
                res.on('error', reject);
            }).on('error', reject);
        };
        follow(url);
    });
}

// ─── Fetch + cache ─────────────────────────────────────────────────────────

export async function getGuides(force = false): Promise<GuideMetadata[]> {
    if (memCache && !force) return memCache;
    if (!inflight) {
        inflight = (async () => {
            if (!force) {
                const stored = guideCtx.globalState.get<GuideMetadata[]>(CACHE_KEY);
                if (stored?.length) { memCache = stored; return stored; }
            }
            const data = await fetchJson<GuideMetadata[]>(GUIDES_URL);
            memCache = data;
            await guideCtx.globalState.update(CACHE_KEY, data);
            return data;
        })().finally(() => { inflight = null; });
    }
    return inflight;
}

export async function reloadGuides(): Promise<GuideMetadata[]> {
    memCache = null;
    await guideCtx.globalState.update(CACHE_KEY, undefined);
    return getGuides(true);
}

// ─── Favorites ─────────────────────────────────────────────────────────────

function readFavs(): Set<number> {
    return new Set(guideCtx.globalState.get<number[]>(FAVS_KEY, []));
}

async function writeFavs(ids: Set<number>): Promise<void> {
    await guideCtx.globalState.update(FAVS_KEY, [...ids].sort((a, b) => a - b));
}

export function isFavorite(id: number): boolean { return readFavs().has(id); }

export async function addFavorite(id: number): Promise<void> {
    const s = readFavs(); s.add(id); await writeFavs(s);
}

export async function removeFavorite(id: number): Promise<void> {
    const s = readFavs(); s.delete(id); await writeFavs(s);
}

// ─── URL builder ───────────────────────────────────────────────────────────

function slugify(s: string | null): string {
    return s?.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '').replace(/-+/g, '-') ?? '';
}

export function buildGuideUrl(g: GuideMetadata): string {
    const path = (g.title ? 'guide' : g.targetType) + '/' + (slugify(g.title) || (g.targetName ?? ''));
    return `${DOCS_BASE}${path}${g.targetType === 'none' ? `-${g.id}` : ''}?p=${g.packageName}`;
}

// ─── Display helpers ───────────────────────────────────────────────────────

export function guideTitle(g: GuideMetadata): string {
    return g.title?.trim() || g.targetName?.trim() || `Guide #${g.id}`;
}

export function guideCategory(g: GuideMetadata): string {
    const c = g.category?.trim();
    if (c) return c;
    const t = g.targetType;
    return (t && t !== 'none') ? t.charAt(0).toUpperCase() + t.slice(1) + 's' : 'General';
}
