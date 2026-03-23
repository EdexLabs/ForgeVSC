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
exports.DOCS_BASE = void 0;
exports.initGuides = initGuides;
exports.getGuides = getGuides;
exports.reloadGuides = reloadGuides;
exports.isFavorite = isFavorite;
exports.addFavorite = addFavorite;
exports.removeFavorite = removeFavorite;
exports.buildGuideUrl = buildGuideUrl;
exports.guideTitle = guideTitle;
exports.guideCategory = guideCategory;
const https = __importStar(require("https"));
// ─── Constants ─────────────────────────────────────────────────────────────
const GUIDES_URL = 'https://raw.githubusercontent.com/tryforge/ForgeScript/refs/heads/metadata/guides.json';
const CACHE_KEY = 'forgescript.guides.cache';
const FAVS_KEY = 'forgescript.guides.favorites';
exports.DOCS_BASE = 'https://docs.botforge.org/';
// ─── Module state ──────────────────────────────────────────────────────────
let guideCtx;
let memCache = null;
let inflight = null;
function initGuides(ctx) {
    guideCtx = ctx;
}
// ─── HTTP helper ───────────────────────────────────────────────────────────
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const follow = (u) => {
            https.get(u, { headers: { 'User-Agent': 'ForgeScript/guides' } }, res => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    res.headers.location ? follow(res.headers.location) : reject(new Error('Redirect without location'));
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode} for ${u}`));
                    return;
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => { try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                }
                catch (e) {
                    reject(e);
                } });
                res.on('error', reject);
            }).on('error', reject);
        };
        follow(url);
    });
}
// ─── Fetch + cache ─────────────────────────────────────────────────────────
async function getGuides(force = false) {
    if (memCache && !force)
        return memCache;
    if (!inflight) {
        inflight = (async () => {
            if (!force) {
                const stored = guideCtx.globalState.get(CACHE_KEY);
                if (stored?.length) {
                    memCache = stored;
                    return stored;
                }
            }
            const data = await fetchJson(GUIDES_URL);
            memCache = data;
            await guideCtx.globalState.update(CACHE_KEY, data);
            return data;
        })().finally(() => { inflight = null; });
    }
    return inflight;
}
async function reloadGuides() {
    memCache = null;
    await guideCtx.globalState.update(CACHE_KEY, undefined);
    return getGuides(true);
}
// ─── Favorites ─────────────────────────────────────────────────────────────
function readFavs() {
    return new Set(guideCtx.globalState.get(FAVS_KEY, []));
}
async function writeFavs(ids) {
    await guideCtx.globalState.update(FAVS_KEY, [...ids].sort((a, b) => a - b));
}
function isFavorite(id) { return readFavs().has(id); }
async function addFavorite(id) {
    const s = readFavs();
    s.add(id);
    await writeFavs(s);
}
async function removeFavorite(id) {
    const s = readFavs();
    s.delete(id);
    await writeFavs(s);
}
// ─── URL builder ───────────────────────────────────────────────────────────
function slugify(s) {
    return s?.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '').replace(/-+/g, '-') ?? '';
}
function buildGuideUrl(g) {
    const path = (g.title ? 'guide' : g.targetType) + '/' + (slugify(g.title) || (g.targetName ?? ''));
    return `${exports.DOCS_BASE}${path}${g.targetType === 'none' ? `-${g.id}` : ''}?p=${g.packageName}`;
}
// ─── Display helpers ───────────────────────────────────────────────────────
function guideTitle(g) {
    return g.title?.trim() || g.targetName?.trim() || `Guide #${g.id}`;
}
function guideCategory(g) {
    const c = g.category?.trim();
    if (c)
        return c;
    const t = g.targetType;
    return (t && t !== 'none') ? t.charAt(0).toUpperCase() + t.slice(1) + 's' : 'General';
}
//# sourceMappingURL=guides.js.map