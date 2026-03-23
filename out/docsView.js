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
exports.getFunctions = getFunctions;
exports.getEnums = getEnums;
exports.getEvents = getEvents;
exports.runSearch = runSearch;
exports.registerDocsView = registerDocsView;
const vscode = __importStar(require("vscode"));
const https = __importStar(require("https"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const guides_1 = require("./guides");
// ─── Constants ─────────────────────────────────────────────────────────────
const CK_FNS = 'forgescript.docsCache.functions';
const CK_ENUMS = 'forgescript.docsCache.enums';
const CK_EVENTS = 'forgescript.docsCache.events';
// ─── Module state ──────────────────────────────────────────────────────────
let ctx;
let log;
let memFns = null;
let memEnums = null;
let memEvents = null;
let inFns = null;
let inEnums = null;
let inEvents = null;
// ─── HTTP helper ───────────────────────────────────────────────────────────
function getJson(url) {
    return new Promise((resolve, reject) => {
        const go = (u) => {
            https.get(u, { headers: { 'User-Agent': 'forgescript-docs/2.0' } }, res => {
                if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                    go(res.headers.location);
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                const b = [];
                res.on('data', (c) => b.push(c));
                res.on('end', () => { try {
                    resolve(JSON.parse(Buffer.concat(b).toString('utf8')));
                }
                catch (e) {
                    reject(e);
                } });
                res.on('error', reject);
            }).on('error', reject);
        };
        go(url);
    });
}
function resolveExtensions() {
    const folders = vscode.workspace.workspaceFolders;
    const cfgPath = folders ? path.join(folders[0].uri.fsPath, 'forgeconfig.json') : null;
    if (cfgPath && fs.existsSync(cfgPath)) {
        try {
            const json = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            const entries = [];
            for (const raw of json.extensions ?? []) {
                if (typeof raw === 'string') {
                    const m = raw.match(/^github:([^/]+)\/([^#]+)#(.+)$/);
                    if (!m)
                        continue;
                    const base = `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/metadata`;
                    const id = `${m[1]}/${m[2]}`;
                    entries.push({ id, label: extLabel(id), functions: `${base}/functions.json`, enums: `${base}/enums.json`, events: `${base}/events.json` });
                }
                else if (raw?.extension) {
                    entries.push({ id: raw.extension, label: extLabel(raw.extension), functions: raw.functions, enums: raw.enums, events: raw.events });
                }
            }
            if (entries.length)
                return entries;
        }
        catch { /* fall through */ }
    }
    const base = 'https://raw.githubusercontent.com/tryforge/ForgeScript/main/metadata';
    return [{ id: 'tryforge/ForgeScript', label: 'ForgeScript', functions: `${base}/functions.json`, enums: `${base}/enums.json`, events: `${base}/events.json` }];
}
// ─── Data loaders ──────────────────────────────────────────────────────────
async function getFunctions(force = false) {
    if (memFns && !force)
        return memFns;
    if (inFns)
        return inFns;
    inFns = (async () => {
        if (!force) {
            const s = ctx.globalState.get(CK_FNS);
            if (s?.length) {
                memFns = s;
                return s;
            }
        }
        const all = [];
        for (const ext of resolveExtensions()) {
            if (!ext.functions)
                continue;
            try {
                const d = await getJson(ext.functions);
                all.push(...d.map(f => ({ ...f, extension: f.extension ?? ext.id })));
            }
            catch (e) {
                log?.appendLine(`[Docs] fn fetch failed ${ext.id}: ${e}`);
            }
        }
        memFns = all;
        await ctx.globalState.update(CK_FNS, all);
        return all;
    })().finally(() => { inFns = null; });
    return inFns;
}
async function getEnums(force = false) {
    if (memEnums && !force)
        return memEnums;
    if (inEnums)
        return inEnums;
    inEnums = (async () => {
        if (!force) {
            const s = ctx.globalState.get(CK_ENUMS);
            if (s?.length) {
                memEnums = s;
                return s;
            }
        }
        const all = [];
        for (const ext of resolveExtensions()) {
            if (!ext.enums)
                continue;
            try {
                const d = await getJson(ext.enums);
                all.push(...Object.entries(d).map(([name, values]) => ({ name, values, extension: ext.id })));
            }
            catch (e) {
                log?.appendLine(`[Docs] enum fetch failed ${ext.id}: ${e}`);
            }
        }
        memEnums = all;
        await ctx.globalState.update(CK_ENUMS, all);
        return all;
    })().finally(() => { inEnums = null; });
    return inEnums;
}
async function getEvents(force = false) {
    if (memEvents && !force)
        return memEvents;
    if (inEvents)
        return inEvents;
    inEvents = (async () => {
        if (!force) {
            const s = ctx.globalState.get(CK_EVENTS);
            if (s?.length) {
                memEvents = s;
                return s;
            }
        }
        const all = [];
        for (const ext of resolveExtensions()) {
            if (!ext.events)
                continue;
            try {
                const d = await getJson(ext.events);
                all.push(...d.map(e => ({ ...e, extension: e.extension ?? ext.id })));
            }
            catch (e) {
                log?.appendLine(`[Docs] event fetch failed ${ext.id}: ${e}`);
            }
        }
        memEvents = all;
        await ctx.globalState.update(CK_EVENTS, all);
        return all;
    })().finally(() => { inEvents = null; });
    return inEvents;
}
async function reloadAll(force = true) {
    memFns = memEnums = memEvents = null;
    await Promise.all([
        ctx.globalState.update(CK_FNS, undefined),
        ctx.globalState.update(CK_ENUMS, undefined),
        ctx.globalState.update(CK_EVENTS, undefined),
    ]);
    await Promise.all([getFunctions(force), getEnums(force), getEvents(force), (0, guides_1.reloadGuides)()]);
}
// ─── Display helpers ───────────────────────────────────────────────────────
function extLabel(id) {
    if (!id)
        return 'ForgeScript';
    const part = id.split('/')[1] ?? id;
    return part.replace(/^forge/i, 'Forge').replace(/\b(db|api|vsc)\b/gi, s => s.toUpperCase());
}
function catLabel(cat) {
    if (!cat)
        return 'General';
    return cat.charAt(0).toUpperCase() + cat.slice(1);
}
function argTypeFmt(a) {
    if (Array.isArray(a.type))
        return a.type.join(' | ');
    return a.type ?? 'any';
}
function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Match guide packageName to extension label (case-insensitive)
function guideMatchesExt(g, extId) {
    const pkg = (g.packageName ?? '').toLowerCase().trim();
    const lbl = extLabel(extId).toLowerCase();
    const part = (extId.split('/')[1] ?? extId).toLowerCase();
    return pkg === lbl || pkg === part || lbl.includes(pkg) || pkg.includes(lbl);
}
// ─── Tree provider ─────────────────────────────────────────────────────────
class ExplorerProvider {
    constructor() {
        this._fire = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._fire.event;
    }
    refresh() { this._fire.fire(); }
    getTreeItem(n) {
        // ── Extension root ──
        if (n.kind === 'extension') {
            const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Collapsed);
            item.id = `ext::${n.uid}`;
            item.iconPath = new vscode.ThemeIcon('package');
            item.contextValue = 'extension';
            return item;
        }
        // ── Section headers ──
        if (n.kind === 'fn-section') {
            const item = new vscode.TreeItem('Functions', vscode.TreeItemCollapsibleState.Collapsed);
            item.id = `fn-sec::${n.uid}`;
            item.iconPath = new vscode.ThemeIcon('symbol-function');
            item.contextValue = 'fn-section';
            return item;
        }
        if (n.kind === 'enum-section') {
            const item = new vscode.TreeItem('Enums', vscode.TreeItemCollapsibleState.Collapsed);
            item.id = `enum-sec::${n.uid}`;
            item.iconPath = new vscode.ThemeIcon('symbol-enum');
            item.contextValue = 'enum-section';
            return item;
        }
        if (n.kind === 'event-section') {
            const item = new vscode.TreeItem('Events', vscode.TreeItemCollapsibleState.Collapsed);
            item.id = `event-sec::${n.uid}`;
            item.iconPath = new vscode.ThemeIcon('symbol-event');
            item.contextValue = 'event-section';
            return item;
        }
        if (n.kind === 'guide-section') {
            const item = new vscode.TreeItem('Guides', vscode.TreeItemCollapsibleState.Collapsed);
            item.id = `guide-sec::${n.uid}`;
            item.iconPath = new vscode.ThemeIcon('book');
            item.contextValue = 'guide-section';
            return item;
        }
        // ── Favorites node under guides section ──
        if (n.kind === 'guide-favorites') {
            const item = new vscode.TreeItem('Favorites', vscode.TreeItemCollapsibleState.Expanded);
            item.id = `guide-favs::${n.uid}`;
            item.iconPath = new vscode.ThemeIcon('star-full');
            item.contextValue = 'guide-favorites';
            return item;
        }
        // ── Category folders ──
        if (n.kind === 'fn-category' || n.kind === 'guide-category' || n.kind === 'guide-subcategory') {
            const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Collapsed);
            item.id = `cat::${n.uid}`;
            item.iconPath = new vscode.ThemeIcon('folder');
            item.contextValue = n.kind;
            return item;
        }
        // ── Function leaf ──
        if (n.kind === 'function' && n.fn) {
            const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
            item.id = `fn::${n.uid}`;
            item.iconPath = new vscode.ThemeIcon(n.fn.deprecated ? 'warning' : n.fn.experimental ? 'beaker' : 'symbol-function');
            item.description = n.fn.deprecated ? 'deprecated' : n.fn.experimental ? 'experimental' : undefined;
            item.tooltip = n.fn.description?.split('\n')[0] ?? n.fn.name;
            item.contextValue = 'function';
            item.command = { command: 'forgevsc.openFunctionDocs', title: '', arguments: [n.fn] };
            return item;
        }
        // ── Enum leaf ──
        if (n.kind === 'enum' && n.enumMeta) {
            const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
            item.id = `enum::${n.uid}`;
            item.iconPath = new vscode.ThemeIcon('symbol-enum');
            item.description = `${n.enumMeta.values.length} values`;
            item.tooltip = n.enumMeta.values.slice(0, 6).join(', ') + (n.enumMeta.values.length > 6 ? '…' : '');
            item.contextValue = 'enum';
            item.command = { command: 'forgevsc.openEnumDocs', title: '', arguments: [n.enumMeta] };
            return item;
        }
        // ── Event leaf ──
        if (n.kind === 'event' && n.eventMeta) {
            const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
            item.id = `event::${n.uid}`;
            item.iconPath = new vscode.ThemeIcon('symbol-event');
            item.description = n.eventMeta.fields?.length ? `${n.eventMeta.fields.length} fields` : undefined;
            item.tooltip = n.eventMeta.description?.split('\n')[0] ?? n.eventMeta.name;
            item.contextValue = 'event';
            item.command = { command: 'forgescript.openEventDocs', title: '', arguments: [n.eventMeta] };
            return item;
        }
        // ── Guide leaf ──
        if (n.kind === 'guide' && n.guide) {
            const g = n.guide;
            const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
            item.id = `guide::${n.uid}`;
            item.iconPath = new vscode.ThemeIcon('book');
            item.contextValue = (0, guides_1.isFavorite)(g.id) ? 'guide.favorite' : 'guide';
            item.command = { command: 'forgescript.openGuide', title: '', arguments: [g] };
            return item;
        }
        // Fallback
        const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `node::${n.uid}`;
        return item;
    }
    async getChildren(parent) {
        // ── Root: one node per extension ──
        if (!parent) {
            const [fns, enums, events, guides] = await Promise.all([getFunctions(), getEnums(), getEvents(), (0, guides_1.getGuides)()]);
            const extIds = [...new Set([
                    ...fns.map(f => f.extension ?? ''),
                    ...enums.map(e => e.extension ?? ''),
                    ...events.map(e => e.extension ?? ''),
                ])].sort();
            // Add extensions that only have guides
            const guideOnlyExts = [...new Set(guides.map(g => g.packageName ?? ''))].filter(pkg => !extIds.some(id => guideMatchesExt({ packageName: pkg }, id)));
            return [
                ...extIds.map(id => ({ kind: 'extension', uid: id, label: extLabel(id), extId: id })),
                ...guideOnlyExts.map(pkg => ({ kind: 'extension', uid: `guide-only::${pkg}`, label: pkg, extId: `guide-only::${pkg}` })),
            ];
        }
        // ── Extension → sections ──
        if (parent.kind === 'extension') {
            const [fns, enums, events, guides] = await Promise.all([getFunctions(), getEnums(), getEvents(), (0, guides_1.getGuides)()]);
            const extId = parent.extId;
            const nodes = [];
            if (fns.some(f => (f.extension ?? '') === extId))
                nodes.push({ kind: 'fn-section', uid: `${extId}::fns`, label: 'Functions', extId });
            if (enums.some(e => (e.extension ?? '') === extId))
                nodes.push({ kind: 'enum-section', uid: `${extId}::enums`, label: 'Enums', extId });
            if (events.some(e => (e.extension ?? '') === extId))
                nodes.push({ kind: 'event-section', uid: `${extId}::events`, label: 'Events', extId });
            if (guides.some(g => guideMatchesExt(g, extId)))
                nodes.push({ kind: 'guide-section', uid: `${extId}::guides`, label: 'Guides', extId });
            return nodes;
        }
        // ── Functions section → categories ──
        if (parent.kind === 'fn-section') {
            const fns = await getFunctions();
            const inExt = fns.filter(f => (f.extension ?? '') === parent.extId);
            const cats = [...new Set(inExt.map(f => f.category ?? ''))].sort();
            return cats.map(cat => ({
                kind: 'fn-category', uid: `${parent.extId}::fn::${cat}`, label: catLabel(cat), extId: parent.extId, category: cat,
            }));
        }
        // ── Function category → functions ──
        if (parent.kind === 'fn-category') {
            const fns = await getFunctions();
            return fns
                .filter(f => (f.extension ?? '') === parent.extId && (f.category ?? '') === parent.category)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(fn => ({
                kind: 'function', uid: `${parent.extId}::fn::${parent.category}::${fn.name}`,
                label: fn.name, extId: parent.extId, category: parent.category, fn,
            }));
        }
        // ── Enums section → enum items ──
        if (parent.kind === 'enum-section') {
            const enums = await getEnums();
            return enums
                .filter(e => (e.extension ?? '') === parent.extId)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(e => ({
                kind: 'enum', uid: `${parent.extId}::enum::${e.name}`, label: e.name, extId: parent.extId, enumMeta: e,
            }));
        }
        // ── Events section → event items ──
        if (parent.kind === 'event-section') {
            const events = await getEvents();
            return events
                .filter(e => (e.extension ?? '') === parent.extId)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(e => ({
                kind: 'event', uid: `${parent.extId}::event::${e.name}`, label: e.name, extId: parent.extId, eventMeta: e,
            }));
        }
        // ── Guides section → Favorites + categories ──
        if (parent.kind === 'guide-section') {
            const guides = await (0, guides_1.getGuides)();
            const inExt = guides.filter(g => guideMatchesExt(g, parent.extId));
            const cats = [...new Set(inExt.map(g => (0, guides_1.guideCategory)(g)))].sort();
            const nodes = [];
            const hasFavs = inExt.some(g => (0, guides_1.isFavorite)(g.id));
            if (hasFavs)
                nodes.push({ kind: 'guide-favorites', uid: `${parent.extId}::guide-favs`, label: 'Favorites', extId: parent.extId });
            nodes.push(...cats.map(cat => ({
                kind: 'guide-category', uid: `${parent.extId}::gcat::${cat}`, label: cat, extId: parent.extId, category: cat,
            })));
            return nodes;
        }
        // ── Guide favorites → guide items ──
        if (parent.kind === 'guide-favorites') {
            const guides = await (0, guides_1.getGuides)();
            return guides
                .filter(g => guideMatchesExt(g, parent.extId) && (0, guides_1.isFavorite)(g.id))
                .sort((a, b) => (0, guides_1.guideTitle)(a).localeCompare((0, guides_1.guideTitle)(b)))
                .map(g => ({
                kind: 'guide', uid: `fav::${g.id}`, label: (0, guides_1.guideTitle)(g), extId: parent.extId, guide: g,
            }));
        }
        // ── Guide category → subcategories + direct guides ──
        if (parent.kind === 'guide-category') {
            const guides = await (0, guides_1.getGuides)();
            const inCat = guides.filter(g => guideMatchesExt(g, parent.extId) && (0, guides_1.guideCategory)(g) === parent.category);
            const subs = [...new Set(inCat.map(g => g.subCategory?.trim()).filter(Boolean))].sort();
            const subNodes = subs.map(sub => ({
                kind: 'guide-subcategory', uid: `${parent.extId}::gcat::${parent.category}::${sub}`,
                label: sub, extId: parent.extId, category: parent.category, subCategory: sub,
            }));
            const direct = inCat
                .filter(g => !g.subCategory?.trim())
                .sort((a, b) => (0, guides_1.guideTitle)(a).localeCompare((0, guides_1.guideTitle)(b)))
                .map(g => ({
                kind: 'guide', uid: `guide::${g.id}`, label: (0, guides_1.guideTitle)(g),
                extId: parent.extId, category: parent.category, guide: g,
            }));
            return [...subNodes, ...direct];
        }
        // ── Guide subcategory → guides ──
        if (parent.kind === 'guide-subcategory') {
            const guides = await (0, guides_1.getGuides)();
            return guides
                .filter(g => guideMatchesExt(g, parent.extId) && (0, guides_1.guideCategory)(g) === parent.category && g.subCategory?.trim() === parent.subCategory)
                .sort((a, b) => (0, guides_1.guideTitle)(a).localeCompare((0, guides_1.guideTitle)(b)))
                .map(g => ({
                kind: 'guide', uid: `guide::${g.id}`, label: (0, guides_1.guideTitle)(g),
                extId: parent.extId, category: parent.category, subCategory: parent.subCategory, guide: g,
            }));
        }
        return [];
    }
}
// ─── Single reused panel ───────────────────────────────────────────────────
let activePanel = null;
function showPanel(title, html) {
    if (activePanel) {
        // Reuse: just swap content and title
        activePanel.title = title;
        activePanel.webview.html = html;
        activePanel.reveal(vscode.ViewColumn.One, true);
    }
    else {
        activePanel = vscode.window.createWebviewPanel('forgescript.docs', title, { viewColumn: vscode.ViewColumn.One, preserveFocus: true }, { enableScripts: false, retainContextWhenHidden: false });
        activePanel.webview.html = html;
        activePanel.onDidDispose(() => { activePanel = null; });
    }
}
async function runSearch() {
    const qp = vscode.window.createQuickPick();
    qp.placeholder = 'Search functions ($), guides (/), enums (?), events (.)…';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.busy = true;
    qp.show();
    const [fns, enums, events, guides] = await Promise.all([getFunctions(), getEnums(), getEvents(), (0, guides_1.getGuides)()]);
    qp.busy = false;
    const allItems = [
        ...fns.map(fn => ({
            label: `$(symbol-function) ${fn.name}`,
            description: catLabel(fn.category),
            detail: (fn.deprecated ? '⚠ deprecated · ' : '') + (fn.description?.split('\n')[0] ?? ''),
            docKind: 'fn',
            payload: fn,
        })),
        ...enums.map(e => ({
            label: `$(symbol-enum) ${e.name}`,
            description: extLabel(e.extension),
            detail: `${e.values.length} values · ${e.values.slice(0, 5).join(', ')}${e.values.length > 5 ? '…' : ''}`,
            docKind: 'enum',
            payload: e,
        })),
        ...events.map(e => ({
            label: `$(symbol-event) ${e.name}`,
            description: extLabel(e.extension),
            detail: e.description?.split('\n')[0] ?? '',
            docKind: 'event',
            payload: e,
        })),
        ...guides.map(g => ({
            label: `$(book) ${(0, guides_1.guideTitle)(g)}`,
            description: g.packageName,
            detail: (0, guides_1.guideCategory)(g) + (g.subCategory ? ` › ${g.subCategory}` : ''),
            docKind: 'guide',
            payload: g,
        })),
    ];
    qp.items = allItems;
    qp.onDidChangeValue(value => {
        let filter = null;
        let query = value;
        if (value.startsWith('$')) {
            filter = 'fn';
            query = value.slice(1);
        }
        else if (value.startsWith('/')) {
            filter = 'guide';
            query = value.slice(1);
        }
        else if (value.startsWith('?')) {
            filter = 'enum';
            query = value.slice(1);
        }
        else if (value.startsWith('.')) {
            filter = 'event';
            query = value.slice(1);
        }
        const q = query.trim().toLowerCase();
        let filtered = filter ? allItems.filter(i => i.docKind === filter) : allItems;
        if (q) {
            filtered = filtered.filter(i => i.label.toLowerCase().includes(q) ||
                i.description?.toLowerCase().includes(q) ||
                i.detail?.toLowerCase().includes(q));
        }
        qp.items = filtered.map(i => ({ ...i, alwaysShow: true }));
    });
    qp.onDidAccept(() => {
        const sel = qp.selectedItems[0];
        if (!sel)
            return;
        qp.hide();
        if (sel.docKind === 'fn') {
            const p = sel.payload;
            showPanel(p.name, buildFnHtml(p));
        }
        if (sel.docKind === 'enum') {
            const p = sel.payload;
            showPanel(p.name, buildEnumHtml(p));
        }
        if (sel.docKind === 'event') {
            const p = sel.payload;
            showPanel(p.name, buildEventHtml(p));
        }
        if (sel.docKind === 'guide') {
            const p = sel.payload;
            showPanel((0, guides_1.guideTitle)(p), buildGuideHtml(p));
        }
    });
    qp.onDidHide(() => qp.dispose());
}
// ─── Shared CSS ────────────────────────────────────────────────────────────
const CSS = `
:root {
  --bg:      var(--vscode-editor-background);
  --fg:      var(--vscode-editor-foreground);
  --border:  var(--vscode-panel-border, #3c3c3c);
  --surface: var(--vscode-sideBar-background, #1e1e1e);
  --code-bg: var(--vscode-textCodeBlock-background, #0d1117);
  --link:    var(--vscode-textLink-foreground, #4fc3f7);
  --warn:    var(--vscode-editorWarning-foreground, #cca700);
  --info:    var(--vscode-editorInfo-foreground, #75beff);
  --muted:   var(--vscode-disabledForeground, #6b6b6b);
  --green:   var(--vscode-terminal-ansiGreen, #4ec9b0);
  --yellow:  var(--vscode-terminal-ansiYellow, #dcdcaa);
  --blue:    var(--vscode-terminal-ansiCyan, #9cdcfe);
  --pink:    var(--vscode-terminal-ansiMagenta, #c586c0);
  --row-alt: var(--vscode-list-hoverBackground, #2a2d2e);
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font-family:var(--vscode-font-family,system-ui,sans-serif);font-size:var(--vscode-font-size,13px);line-height:1.6;max-width:900px;margin:0 auto;padding:32px 36px 72px}
hr{border:none;border-top:1px solid var(--border);margin:28px 0}
section{margin-bottom:28px}
h2{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:14px}

/* Header */
.hdr{display:flex;align-items:flex-start;gap:18px;margin-bottom:28px}
.hdr-icon{font-size:34px;line-height:1;flex-shrink:0;margin-top:3px}
.hdr-body{flex:1;min-width:0}
.hdr-name{font-size:28px;font-weight:700;font-family:var(--vscode-editor-font-family,'Consolas',monospace);word-break:break-all}
.fn-c{color:var(--yellow)} .en-c{color:var(--green)} .ev-c{color:var(--blue)} .gd-c{color:var(--link)}
.hdr-sub{font-size:11px;color:var(--muted);margin-top:3px;letter-spacing:.05em;text-transform:uppercase}
.badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.badge{font-size:10px;font-weight:700;padding:2px 9px;border-radius:20px;letter-spacing:.05em;text-transform:uppercase}
.bw{background:color-mix(in srgb,var(--warn)18%,transparent);color:var(--warn);border:1px solid color-mix(in srgb,var(--warn)38%,transparent)}
.bi{background:color-mix(in srgb,var(--info)18%,transparent);color:var(--info);border:1px solid color-mix(in srgb,var(--info)38%,transparent)}
.bm{background:color-mix(in srgb,var(--muted)18%,transparent);color:var(--muted);border:1px solid color-mix(in srgb,var(--muted)30%,transparent)}

/* Usage */
.usage{background:var(--code-bg);border:1px solid var(--border);border-left:3px solid var(--yellow);border-radius:6px;padding:14px 20px;margin-bottom:28px;font-family:var(--vscode-editor-font-family,'Consolas',monospace);font-size:14px;overflow-x:auto;white-space:pre}
.u-fn{color:var(--yellow)} .u-br{color:var(--fg)} .u-arg{color:var(--blue)} .u-sep{color:var(--muted)} .u-type{color:var(--green)} .u-opt{color:var(--muted)}

/* Guide content */
.guide-content{line-height:1.75;color:var(--fg)}
.guide-content h1{font-size:22px;margin:0 0 12px;color:var(--link)}
.guide-content h2{font-size:16px;margin:20px 0 8px;color:var(--blue);text-transform:none;letter-spacing:0}
.guide-content h3{font-size:14px;margin:16px 0 6px;color:var(--green)}
.guide-content p{margin:8px 0}
.guide-content code{font-family:var(--vscode-editor-font-family,monospace);background:var(--code-bg);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-size:.88em}
.guide-content pre{background:var(--code-bg);border:1px solid var(--border);border-radius:5px;padding:12px 16px;margin:12px 0;overflow-x:auto}
.guide-content pre code{background:none;border:none;padding:0;font-size:13px}
.guide-content blockquote{border-left:3px solid var(--muted);padding:2px 14px;margin:8px 0;color:var(--muted)}
.guide-content strong{font-weight:700;color:var(--fg)}
.guide-content em{font-style:italic}
.guide-content hr{border:none;border-top:1px solid var(--border);margin:16px 0}
.guide-content a{color:var(--link)}
.guide-meta{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px;font-size:12px;color:var(--muted)}
.guide-meta span{display:flex;align-items:center;gap:4px}

/* Table */
table{width:100%;border-collapse:collapse;font-size:12.5px}
thead tr{background:var(--surface);border-bottom:1px solid var(--border)}
th{text-align:left;padding:8px 14px;font-weight:600;color:var(--muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.05em}
td{padding:9px 14px;vertical-align:top;border-bottom:1px solid color-mix(in srgb,var(--border)45%,transparent)}
tbody tr:nth-child(even){background:color-mix(in srgb,var(--row-alt)35%,transparent)}
tbody tr:hover{background:var(--row-alt)}
.t-name{color:var(--blue);font-family:var(--vscode-editor-font-family,monospace)}
.t-type{color:var(--green);font-family:var(--vscode-editor-font-family,monospace)}
.t-req{color:var(--pink);font-size:10.5px;font-weight:700}
.t-opt{color:var(--muted);font-size:10.5px}
.t-rest{color:var(--info);font-size:10.5px;font-weight:700}
.chips{margin-top:6px;display:flex;gap:4px;flex-wrap:wrap}
.chip{font-size:11px;border-radius:3px;padding:1px 7px;background:color-mix(in srgb,var(--green)10%,transparent);border:1px solid color-mix(in srgb,var(--green)22%,transparent);color:var(--green);font-family:var(--vscode-editor-font-family,monospace)}

/* Output / Aliases / Enum grid */
.pill-row{display:flex;gap:8px;flex-wrap:wrap}
.pill-out{font-family:var(--vscode-editor-font-family,monospace);background:color-mix(in srgb,var(--pink)12%,transparent);border:1px solid color-mix(in srgb,var(--pink)25%,transparent);color:var(--pink);border-radius:4px;padding:3px 12px;font-size:13px}
.pill-alias{font-family:var(--vscode-editor-font-family,monospace);background:var(--code-bg);border:1px solid var(--border);color:var(--yellow);border-radius:4px;padding:3px 12px;font-size:13px}
.pill-enum{font-family:var(--vscode-editor-font-family,monospace);background:var(--code-bg);border:1px solid var(--border);color:var(--green);border-radius:4px;padding:4px 12px;font-size:13px}

/* Links */
.links{display:flex;gap:10px;flex-wrap:wrap}
.link-btn{display:inline-flex;align-items:center;gap:6px;background:var(--surface);border:1px solid var(--border);border-radius:5px;padding:6px 16px;color:var(--link);text-decoration:none;font-size:12.5px;font-weight:500}
.link-btn:hover{background:color-mix(in srgb,var(--link)10%,transparent);border-color:var(--link)}
`;
function shell(title, body) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}
// ─── Function HTML ──────────────────────────────────────────────────────────
function buildFnHtml(fn) {
    const args = fn.args ?? [];
    const hasArgs = args.length > 0;
    const showBr = fn.brackets ?? hasArgs;
    const pkgId = (fn.extension ?? '').split('/')[1] ?? fn.extension ?? '';
    const slug = fn.name.replace('$', '');
    const badges = [
        ...(fn.deprecated ? [`<span class="badge bw">Deprecated</span>`] : []),
        ...(fn.experimental ? [`<span class="badge bi">Experimental</span>`] : []),
        ...(fn.aliases?.length ? [`<span class="badge bm">+${fn.aliases.length} alias${fn.aliases.length === 1 ? '' : 'es'}</span>`] : []),
    ];
    let usageInner = '';
    if (hasArgs) {
        usageInner = args.map((a, i) => {
            const pre = a.rest ? '<span class="u-opt">...</span>' : '';
            const suf = (!a.required && !a.rest) ? '<span class="u-opt">?</span>' : '';
            const sep = i < args.length - 1 ? '<span class="u-sep">; </span>' : '';
            return `${pre}<span class="u-arg">${esc(a.name)}</span>${suf}<span class="u-sep">: </span><span class="u-type">${esc(argTypeFmt(a))}</span>${sep}`;
        }).join('');
    }
    const usageBr = showBr ? `<span class="u-br">[</span>${usageInner}<span class="u-br">]</span>` : '';
    const argRows = args.map(a => {
        const req = a.required === true ? '<span class="t-req">required</span>' : a.rest ? '<span class="t-rest">...rest</span>' : '<span class="t-opt">optional</span>';
        const chps = a.enum?.length ? `<div class="chips">${a.enum.map(v => `<span class="chip">${esc(v)}</span>`).join('')}</div>` : '';
        return `<tr><td><code class="t-name">${esc(a.name)}</code></td><td><code class="t-type">${esc(argTypeFmt(a))}</code></td><td>${req}</td><td>${esc(a.description ?? '')}${chps}</td></tr>`;
    }).join('');
    const links = [
        `<a class="link-btn" href="${guides_1.DOCS_BASE}function/$${esc(slug)}?p=${esc(pkgId)}">📖 Docs</a>`,
        ...(fn.source_url ? [`<a class="link-btn" href="${esc(fn.source_url)}">⚡ Source</a>`] : []),
    ];
    return shell(fn.name, `
<div class="hdr">
  <div class="hdr-icon">⚡</div>
  <div class="hdr-body">
    <div class="hdr-name fn-c">${esc(fn.name)}</div>
    <div class="hdr-sub">${esc(extLabel(fn.extension))}</div>
    ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
  </div>
</div>
<div class="usage"><span class="u-fn">${esc(fn.name)}</span>${usageBr}</div>
${fn.description ? `<section><h2>Description</h2><div class="guide-content"><p>${esc(fn.description)}</p></div></section>` : ''}
${hasArgs ? `<section><h2>Arguments</h2><table><thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>${argRows}</tbody></table></section>` : ''}
${fn.output?.length ? `<section><h2>Returns</h2><div class="pill-row">${fn.output.map(o => `<span class="pill-out">${esc(o)}</span>`).join('')}</div></section>` : ''}
${fn.aliases?.length ? `<section><h2>Aliases</h2><div class="pill-row">${fn.aliases.map(a => `<span class="pill-alias">${esc(a.startsWith('$') ? a : '$' + a)}</span>`).join('')}</div></section>` : ''}
<hr><section><h2>Links</h2><div class="links">${links.join('')}</div></section>`);
}
// ─── Enum HTML ─────────────────────────────────────────────────────────────
function buildEnumHtml(e) {
    const cols = Math.min(4, Math.ceil(e.values.length / 5));
    const style = cols > 1 ? `display:grid;grid-template-columns:repeat(${cols},1fr);gap:8px` : 'display:flex;flex-wrap:wrap;gap:8px';
    return shell(e.name, `
<div class="hdr">
  <div class="hdr-icon">📋</div>
  <div class="hdr-body">
    <div class="hdr-name en-c">${esc(e.name)}</div>
    <div class="hdr-sub">${esc(extLabel(e.extension))} · ${e.values.length} values</div>
  </div>
</div>
<section><h2>Values</h2><div style="${style}">${e.values.map(v => `<span class="pill-enum">${esc(v)}</span>`).join('')}</div></section>`);
}
// ─── Event HTML ────────────────────────────────────────────────────────────
function buildEventHtml(e) {
    const rows = (e.fields ?? []).map(f => `<tr><td><code class="t-name">${esc(f.name)}</code></td><td>${esc(f.description ?? '')}</td></tr>`).join('');
    return shell(e.name, `
<div class="hdr">
  <div class="hdr-icon">🔔</div>
  <div class="hdr-body">
    <div class="hdr-name ev-c">${esc(e.name)}</div>
    <div class="hdr-sub">${esc(extLabel(e.extension))}</div>
  </div>
</div>
${e.description ? `<section><h2>Description</h2><div class="guide-content"><p>${esc(e.description)}</p></div></section>` : ''}
${rows ? `<section><h2>Fields</h2><table><thead><tr><th>Name</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table></section>` : ''}`);
}
// ─── Guide HTML ────────────────────────────────────────────────────────────
/** Minimal markdown → HTML for guide content */
function mdToHtml(md) {
    const lines = md.split('\n');
    const out = [];
    let inCode = false;
    let codeLang = '';
    let codeBuf = [];
    for (let raw of lines) {
        // Fenced code blocks
        if (raw.startsWith('```')) {
            if (!inCode) {
                inCode = true;
                codeLang = raw.slice(3).trim();
                codeBuf = [];
            }
            else {
                out.push(`<pre><code>${codeBuf.map(l => esc(l)).join('\n')}</code></pre>`);
                inCode = false;
            }
            continue;
        }
        if (inCode) {
            codeBuf.push(raw);
            continue;
        }
        // Headings
        if (raw.startsWith('### ')) {
            out.push(`<h3>${inlineM(raw.slice(4))}</h3>`);
            continue;
        }
        if (raw.startsWith('## ')) {
            out.push(`<h2>${inlineM(raw.slice(3))}</h2>`);
            continue;
        }
        if (raw.startsWith('# ')) {
            out.push(`<h1>${inlineM(raw.slice(2))}</h1>`);
            continue;
        }
        // Blockquotes
        if (raw.startsWith('> ')) {
            out.push(`<blockquote><p>${inlineM(raw.slice(2))}</p></blockquote>`);
            continue;
        }
        // HR
        if (/^---+$/.test(raw.trim())) {
            out.push('<hr>');
            continue;
        }
        // Empty line
        if (!raw.trim()) {
            out.push('');
            continue;
        }
        // Normal paragraph line
        out.push(`<p>${inlineM(raw)}</p>`);
    }
    return out.join('\n');
}
function inlineM(s) {
    return esc(s)
        // bold
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        // italic
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        // inline code
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // links
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}
function buildGuideHtml(g) {
    const title = (0, guides_1.guideTitle)(g);
    const when = g.approvedAt ? new Date(g.approvedAt).toLocaleDateString() : '';
    const contribs = (g.contributors ?? []).map(c => `<code>${esc(c.username)}</code>`).join(', ') || '—';
    const docsUrl = (0, guides_1.buildGuideUrl)(g);
    return shell(title, `
<div class="hdr">
  <div class="hdr-icon">📖</div>
  <div class="hdr-body">
    <div class="hdr-name gd-c">${esc(title)}</div>
    <div class="hdr-sub">${esc(g.packageName)}</div>
  </div>
</div>
<div class="guide-meta">
  ${when ? `<span>✅ Approved ${esc(when)} by <code>${esc(g.approver?.username ?? '')}</code></span>` : ''}
  <span>👥 ${contribs}</span>
</div>
<div class="guide-content">${mdToHtml(g.content ?? '*No content available.*')}</div>
<hr>
<section><h2>Links</h2><div class="links">
  <a class="link-btn" href="${esc(docsUrl)}">📖 Open on Docs Site</a>
</div></section>`);
}
// ─── Register everything ───────────────────────────────────────────────────
function registerDocsView(extCtx, channel) {
    ctx = extCtx;
    log = channel;
    const provider = new ExplorerProvider();
    extCtx.subscriptions.push(vscode.window.createTreeView('forgescript.explorerView', {
        treeDataProvider: provider,
        showCollapseAll: true,
    }));
    extCtx.subscriptions.push(
    // ── Docs openers ──
    vscode.commands.registerCommand('forgescript.openFunctionDocs', (input) => {
        if (typeof input === 'string') {
            getFunctions().then(fns => { const f = fns.find(f => f.name.toLowerCase() === input.toLowerCase()); f ? showPanel(f.name, buildFnHtml(f)) : vscode.window.showErrorMessage(`Function "${input}" not found.`); });
        }
        else {
            showPanel(input.name, buildFnHtml(input));
        }
    }), vscode.commands.registerCommand('forgescript.openEnumDocs', (input) => {
        if (typeof input === 'string') {
            getEnums().then(es => { const e = es.find(e => e.name.toLowerCase() === input.toLowerCase()); e ? showPanel(e.name, buildEnumHtml(e)) : vscode.window.showErrorMessage(`Enum "${input}" not found.`); });
        }
        else {
            showPanel(input.name, buildEnumHtml(input));
        }
    }), vscode.commands.registerCommand('forgescript.openEventDocs', (input) => {
        if (typeof input === 'string') {
            getEvents().then(es => { const e = es.find(e => e.name.toLowerCase() === input.toLowerCase()); e ? showPanel(e.name, buildEventHtml(e)) : vscode.window.showErrorMessage(`Event "${input}" not found.`); });
        }
        else {
            showPanel(input.name, buildEventHtml(input));
        }
    }), 
    // Open guide in webview panel
    vscode.commands.registerCommand('forgescript.openGuide', (input) => {
        const open = (g) => showPanel((0, guides_1.guideTitle)(g), buildGuideHtml(g));
        if (typeof input === 'object' && input) {
            open(input);
            return;
        }
        (0, guides_1.getGuides)().then(all => {
            const id = typeof input === 'number' ? input : Number(input);
            const g = !isNaN(id) ? all.find(g => g.id === id) : all.find(g => (0, guides_1.guideTitle)(g).toLowerCase() === String(input).toLowerCase());
            g ? open(g) : vscode.window.showErrorMessage(`Guide not found.`);
        });
    }), 
    // Open guide external → webview (same as openGuide)
    vscode.commands.registerCommand('forgevsc.openGuideExternal', (node) => {
        if (!node?.guide)
            return;
        showPanel((0, guides_1.guideTitle)(node.guide), buildGuideHtml(node.guide));
    }), 
    // Favorite / unfavorite
    vscode.commands.registerCommand('forgevsc.favoriteGuide', async (node) => {
        if (!node?.guide)
            return;
        await (0, guides_1.addFavorite)(node.guide.id);
        provider.refresh();
    }), vscode.commands.registerCommand('forgevsc.unfavoriteGuide', async (node) => {
        if (!node?.guide)
            return;
        await (0, guides_1.removeFavorite)(node.guide.id);
        provider.refresh();
    }), 
    // Search (QuickPick over all data)
    vscode.commands.registerCommand('forgevsc.searchFunctions', () => runSearch()), vscode.commands.registerCommand('forgevsc.searchGuides', () => runSearch()), 
    // Reload all
    vscode.commands.registerCommand('forgevsc.reloadFunctions', async () => {
        await reloadAll();
        provider.refresh();
        const [fns, enums, events, guides] = await Promise.all([getFunctions(), getEnums(), getEvents(), (0, guides_1.getGuides)()]);
        vscode.window.showInformationMessage(`ForgeVSC: Reloaded — ${fns.length} functions, ${enums.length} enums, ${events.length} events, ${guides.length} guides.`);
    }), vscode.commands.registerCommand('forgevsc.reloadGuides', async () => {
        await (0, guides_1.reloadGuides)();
        provider.refresh();
        const guides = await (0, guides_1.getGuides)();
        vscode.window.showInformationMessage(`ForgeVSC: Reloaded ${guides.length} guides.`);
    }));
    // Background preload
    Promise.all([getFunctions(), getEnums(), getEvents(), (0, guides_1.getGuides)()]).then(() => provider.refresh());
    // Invalidate on forgeconfig changes
    const w = vscode.workspace.createFileSystemWatcher('**/forgeconfig.json');
    extCtx.subscriptions.push(w, w.onDidChange(async () => { await reloadAll(); provider.refresh(); }), w.onDidCreate(async () => { await reloadAll(); provider.refresh(); }));
}
//# sourceMappingURL=docsView.js.map