import * as vscode from 'vscode';
import * as path from 'path';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
import { LspInitOptions } from './configReader';

let client: LanguageClient | null = null;

const DOC_SELECTOR = [
  { scheme: 'file', language: 'javascript' },
  { scheme: 'file', language: 'typescript' },
  { scheme: 'file', language: 'javascriptreact' },
  { scheme: 'file', language: 'typescriptreact' },
  { scheme: 'file', language: 'forge' },
];

export function createClient(
  binaryPath: string,
  initOptions: LspInitOptions | null,
  outputChannel: vscode.OutputChannel,
  storageDir: string
): LanguageClient {
  const serverOptions: ServerOptions = {
    command: binaryPath,
    args: [],
    transport: TransportKind.stdio,
  };

  // Build camelCase init options to match the Rust serde(rename_all = "camelCase")
  const initializationOptions: Record<string, unknown> = {};

  if (initOptions?.metadataUrls) {
    initializationOptions['metadataUrls'] = initOptions.metadataUrls.map((m) => {
      const entry: Record<string, string> = { extension: m.extension };
      if (m.functions) entry['functions'] = m.functions;
      if (m.enums) entry['enums'] = m.enums;
      if (m.events) entry['events'] = m.events;
      return entry;
    });
  }

  if (initOptions?.customFunctionsPath) {
    initializationOptions['customFunctionsPath'] = initOptions.customFunctionsPath;
  }

  if (initOptions?.customFunctionsJson) {
    initializationOptions['customFunctionsJson'] = initOptions.customFunctionsJson;
  }

  if (initOptions?.customColors) {
    initializationOptions['customColors'] = initOptions.customColors;
  }

  if (initOptions?.constantCustomColors !== undefined) {
    initializationOptions['constantCustomColors'] = initOptions.constantCustomColors;
  }

  // Expose cache path inside extension storage so it survives restarts
  initializationOptions['cachePath'] = path.join(storageDir, 'metadata.json');

  const clientOptions: LanguageClientOptions = {
    documentSelector: DOC_SELECTOR,
    outputChannel,
    initializationOptions,
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/forgeconfig.json'),
    },
    middleware: {
      provideCompletionItem: (document: any, position: any, context: any, token: any, next: any) => {
        if (!shouldRunLsp(document, position)) return undefined;
        return next(document, position, context, token);
      },
      provideHover: (document: any, position: any, token: any, next: any) => {
        if (!shouldRunLsp(document, position)) return undefined;
        return next(document, position, token);
      },
      provideSignatureHelp: (document: any, position: any, context: any, token: any, next: any) => {
        if (!shouldRunLsp(document, position)) return undefined;
        return next(document, position, context, token);
      },
      provideDefinition: (document: any, position: any, token: any, next: any) => {
        if (!shouldRunLsp(document, position)) return undefined;
        return next(document, position, token);
      },
    } as any
  };

  return new LanguageClient(
    'forgelsp',
    'ForgeLSP',
    serverOptions,
    clientOptions
  );
}

/**
 * Returns true if we should perform LSP actions at the given position.
 * For JS/TS documents, this means being inside unescaped backticks.
 */
function shouldRunLsp(document: vscode.TextDocument, position: vscode.Position): boolean {
  if (document.languageId === 'forge') {
    return true;
  }

  const text = document.getText();
  const offset = document.offsetAt(position);

  let inside = false;
  let escaped = false;

  for (let i = 0; i < offset; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
    } else if (char === '`') {
      inside = !inside;
    }
  }

  return inside;
}

export async function startClient(c: LanguageClient): Promise<void> {
  client = c;
  await client.start();
}

export async function stopClient(): Promise<void> {
  if (client) {
    await client.stop();
    client = null;
  }
}

export function getClient(): LanguageClient | null {
  return client;
}

export function isRunning(): boolean {
  return client !== null;
}
