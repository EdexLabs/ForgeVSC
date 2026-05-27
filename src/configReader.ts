import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ─── Schema types ──────────────────────────────────────────────────────────

interface ExtensionObject {
  extension: string;
  functions?: string;
  enums?: string;
  events?: string;
}

type ExtensionEntry = string | ExtensionObject;

interface ForgeConfigJson {
  extensions?: ExtensionEntry[];
  custom_functions_path?: string | string[];
  custom_functions_json?: string;
  // Function cycling colors
  custom_colors?: string[];
  constant_custom_colors?: boolean;
  // Per-token-type colors (single key per type, snake_case)
  custom_color_text?: string;       // string/text (was also custom_color_string)
  custom_color_time?: string;
  custom_color_number?: string;     // numbers
  custom_color_modifier?: string;   // operators/modifiers
  custom_color_operator?: string;   // alias for modifier
  custom_color_separator?: string;  // argument separators
  custom_color_dollar?: string;
  custom_color_boolean?: string;
  // Dual-decoration mode
  semantic_decorations?: boolean;
}

// ─── LSP initialization options (matches the Rust ForgeConfig struct) ─────

export interface MetadataUrlConfig {
  extension: string;
  functions?: string;
  enums?: string;
  events?: string;
}

export interface LspInitOptions {
  metadataUrls?: MetadataUrlConfig[];
  customFunctionsPath?: string | string[];
  customFunctionsJson?: string;
  cachePath?: string;
  // Function cycling colors (existing)
  customColors?: string[];
  constantCustomColors?: boolean;
  // Per-token-type colors (new, optional single hex strings)
  customColorText?: string;
  customColorTime?: string;
  customColorNumbers?: string;
  customColorSeparators?: string;
  customColorDollar?: string;
  customColorModifiers?: string;
  customColorBoolean?: string;
  // Dual-decoration mode
  semanticDecorations?: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Expands "github:user/repo#branch" into raw GitHub URLs for
 * functions.json, enums.json, and events.json.
 */
function expandGithubShorthand(shorthand: string): MetadataUrlConfig {
  const match = shorthand.match(/^github:([^/]+)\/([^#]+)#(.+)$/);
  if (!match) {
    throw new Error(`Invalid github shorthand: "${shorthand}" (expected github:user/repo#branch)`);
  }
  const [, user, repo, branch] = match;
  const base = `https://raw.githubusercontent.com/${user}/${repo}/${branch}/metadata`;
  return {
    extension: `${user}/${repo}`,
    functions: `${base}/functions.json`,
    enums: `${base}/enums.json`,
    events: `${base}/events.json`,
  };
}

function resolveRelativePath(configDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath;
  return path.resolve(configDir, relativePath);
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Locates forgeconfig.json in the workspace root (first workspace folder).
 * Returns null if not found.
 */
export function findForgeConfig(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;

  for (const folder of folders) {
    const candidate = path.join(folder.uri.fsPath, 'forgeconfig.json');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Reads and parses forgeconfig.json, converting it into LSP initialization
 * options that the server understands.
 *
 * Returns null if the file doesn't exist or is malformed.
 */
export function readForgeConfig(
  configPath: string,
  outputChannel: vscode.OutputChannel
): LspInitOptions | null {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    outputChannel.appendLine(`[ForgeLSP] Cannot read forgeconfig.json: ${err}`);
    return null;
  }

  let json: ForgeConfigJson;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    outputChannel.appendLine(`[ForgeLSP] forgeconfig.json is not valid JSON: ${err}`);
    return null;
  }

  const configDir = path.dirname(configPath);
  const opts: LspInitOptions = {};

  // ── extensions → metadataUrls ──────────────────────────────────────────
  if (Array.isArray(json.extensions) && json.extensions.length > 0) {
    opts.metadataUrls = [];
    for (const entry of json.extensions) {
      try {
        if (typeof entry === 'string') {
          opts.metadataUrls.push(expandGithubShorthand(entry));
        } else if (typeof entry === 'object' && entry.extension) {
          const m: MetadataUrlConfig = { extension: entry.extension };
          if (entry.functions) m.functions = entry.functions;
          if (entry.enums) m.enums = entry.enums;
          if (entry.events) m.events = entry.events;
          opts.metadataUrls.push(m);
        } else {
          outputChannel.appendLine(`[ForgeLSP] Skipping invalid extension entry: ${JSON.stringify(entry)}`);
        }
      } catch (e) {
        outputChannel.appendLine(`[ForgeLSP] Extension parse error: ${e}`);
      }
    }
  }

  // ── custom_functions_path ──────────────────────────────────────────────
  if (json.custom_functions_path) {
    if (Array.isArray(json.custom_functions_path)) {
      opts.customFunctionsPath = json.custom_functions_path.map(p => resolveRelativePath(configDir, p));
    } else {
      opts.customFunctionsPath = resolveRelativePath(configDir, json.custom_functions_path);
    }
  }

  // ── custom_functions_json ──────────────────────────────────────────────
  if (json.custom_functions_json) {
    opts.customFunctionsJson = resolveRelativePath(configDir, json.custom_functions_json);
  }

  // ── custom_colors ──────────────────────────────────────────────────────
  if (json.custom_colors && Array.isArray(json.custom_colors)) {
    opts.customColors = json.custom_colors;
  }

  // ── constant_custom_colors ─────────────────────────────────────────────
  if (typeof json.constant_custom_colors === 'boolean') {
    opts.constantCustomColors = json.constant_custom_colors;
  }

  // ── per-type colors ────────────────────────────────────────────────────
  if (json.custom_color_text) { opts.customColorText = json.custom_color_text; }

  if (json.custom_color_time) { opts.customColorTime = json.custom_color_time; }

  const numVal = json.custom_color_number;
  if (numVal) { opts.customColorNumbers = numVal; }

  const sepVal = json.custom_color_separator;
  if (sepVal) { opts.customColorSeparators = sepVal; }

  if (json.custom_color_dollar) { opts.customColorDollar = json.custom_color_dollar; }

  const modVal = json.custom_color_modifier ?? json.custom_color_operator;
  if (modVal) { opts.customColorModifiers = modVal; }

  const boolVal = json.custom_color_boolean;
  if (boolVal) { opts.customColorBoolean = boolVal; }

  // ── semantic_decorations ───────────────────────────────────────────────
  if (typeof json.semantic_decorations === 'boolean') {
    opts.semanticDecorations = json.semantic_decorations;
  }

  outputChannel.appendLine(
    `[ForgeLSP] Loaded forgeconfig.json: ${opts.metadataUrls?.length ?? 0} extension(s)` +
    (opts.customFunctionsPath ? `, custom path: ${Array.isArray(opts.customFunctionsPath) ? opts.customFunctionsPath.join(', ') : opts.customFunctionsPath}` : '') +
    (opts.customFunctionsJson ? `, custom JSON: ${opts.customFunctionsJson}` : '')
  );

  return opts;
}

/**
 * Opens forgeconfig.json in the editor, or creates a minimal one if it doesn't exist.
 */
export async function openOrCreateForgeConfig(outputChannel: vscode.OutputChannel): Promise<void> {
  const existing = findForgeConfig();
  if (existing) {
    const doc = await vscode.workspace.openTextDocument(existing);
    await vscode.window.showTextDocument(doc);
    return;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage('ForgeLSP: No workspace folder open.');
    return;
  }

  const newPath = path.join(folders[0].uri.fsPath, 'forgeconfig.json');
  const scaffold = JSON.stringify(
    {
      "$schema": "https://raw.githubusercontent.com/EdexLabs/ForgeLSP/main/forgeconfig.schema.json",
      "extensions": [
        "github:tryforge/forgescript#dev"
      ],
      "custom_functions_path": "addPathHereRelativeToFile"
    },
    null,
    2
  );

  fs.writeFileSync(newPath, scaffold, 'utf8');
  outputChannel.appendLine(`[ForgeLSP] Created forgeconfig.json at ${newPath}`);
  const doc = await vscode.workspace.openTextDocument(newPath);
  await vscode.window.showTextDocument(doc);
}