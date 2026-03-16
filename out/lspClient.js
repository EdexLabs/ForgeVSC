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
exports.createClient = createClient;
exports.startClient = startClient;
exports.stopClient = stopClient;
exports.getClient = getClient;
exports.isRunning = isRunning;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const node_1 = require("vscode-languageclient/node");
let client = null;
const DOC_SELECTOR = [
    { scheme: 'file', language: 'javascript' },
    { scheme: 'file', language: 'typescript' },
    { scheme: 'file', language: 'javascriptreact' },
    { scheme: 'file', language: 'typescriptreact' },
    { scheme: 'file', language: 'forge' },
];
function createClient(binaryPath, initOptions, outputChannel, storageDir) {
    const serverOptions = {
        command: binaryPath,
        args: [],
        transport: node_1.TransportKind.stdio,
    };
    // Build camelCase init options to match the Rust serde(rename_all = "camelCase")
    const initializationOptions = {};
    if (initOptions?.metadataUrls) {
        initializationOptions['metadataUrls'] = initOptions.metadataUrls.map((m) => {
            const entry = { extension: m.extension };
            if (m.functions)
                entry['functions'] = m.functions;
            if (m.enums)
                entry['enums'] = m.enums;
            if (m.events)
                entry['events'] = m.events;
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
    // Expose cache path inside extension storage so it survives restarts
    initializationOptions['cachePath'] = path.join(storageDir, 'metadata.json');
    const clientOptions = {
        documentSelector: DOC_SELECTOR,
        outputChannel,
        initializationOptions,
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/forgeconfig.json'),
        },
        middleware: {
            provideCompletionItem: (document, position, context, token, next) => {
                if (!shouldRunLsp(document, position))
                    return undefined;
                return next(document, position, context, token);
            },
            provideHover: (document, position, token, next) => {
                if (!shouldRunLsp(document, position))
                    return undefined;
                return next(document, position, token);
            },
            provideSignatureHelp: (document, position, context, token, next) => {
                if (!shouldRunLsp(document, position))
                    return undefined;
                return next(document, position, context, token);
            },
            provideDefinition: (document, position, token, next) => {
                if (!shouldRunLsp(document, position))
                    return undefined;
                return next(document, position, token);
            },
        } // Use any temporarily to avoid complex type imports while ensuring functionality
    };
    return new node_1.LanguageClient('forgelsp', 'ForgeLSP', serverOptions, clientOptions);
}
/**
 * Returns true if we should perform LSP actions at the given position.
 * For JS/TS documents, this means being inside unescaped backticks.
 * For .forge documents, this is always true.
 */
function shouldRunLsp(document, position) {
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
        }
        else if (char === '`') {
            inside = !inside;
        }
    }
    return inside;
}
async function startClient(c) {
    client = c;
    await client.start();
}
async function stopClient() {
    if (client) {
        await client.stop();
        client = null;
    }
}
function getClient() {
    return client;
}
function isRunning() {
    return client !== null;
}
//# sourceMappingURL=lspClient.js.map