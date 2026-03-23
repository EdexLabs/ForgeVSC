# ForgeLSP — VS Code Extension

Language support for **ForgeScript** inside JavaScript and TypeScript files, powered by the [ForgeLSP](https://github.com/EdexLabs/ForgeLSP) language server.

## Features

- Highlighting for `.forge` files.
- Integration with ForgeLSP for diagnostics and completions.
- Searchable documentation for functions, enums, and events.
- Guides for common tasks.

## Configuration

The extension uses `forgeconfig.json` for configuration.

Example `forgeconfig.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/EdexLabs/ForgeScript/main/forgeconfig.schema.json",
  "extensions": [
    "github:tryforge/forgescript#dev"
  ],
  "custom_functions_path": "addPathHereRelativeToFile",
  "custom_colors": ["#ff0000", "#00ff00", "#0000ff"],
  "constant_custom_colors": true
}
```

The file is watched automatically — saving it restarts the server.

---

## Commands

| Command                                   | Description                                 |
| ----------------------------------------- | ------------------------------------------- |
| **ForgeScript: Start Server**             | Start the language server                   |
| **ForgeScript: Stop Server**              | Stop the language server                    |
| **ForgeScript: Restart Server**           | Restart (picks up config changes)           |
| **ForgeScript: Force Update Binary**      | Download the latest official binary         |
| **ForgeScript: Check for Updates**        | Check GitHub for a newer release            |
| **ForgeScript: Set Custom Binary Path**   | Point to a custom ForgeLSP executable       |
| **ForgeScript: Reset to Official Binary** | Undo custom binary, revert to official      |
| **ForgeScript: Show Version**             | Show installed and latest available version |
| **ForgeScript: Show Status**              | Display a detailed status panel             |
| **ForgeScript: Open Output Log**          | Open the ForgeLSP output channel            |
| **ForgeScript: Reload forgeconfig.json**  | Force config reload and server restart      |
| **ForgeScript: Open forgeconfig.json**    | Open (or scaffold) forgeconfig.json         |
| **ForgeScript: Create forgeconfig.json**  | Create a new forgeconfig.json               |

---

## Binary Management

On first activation the extension downloads the correct platform binary from the [latest GitHub release](https://github.com/EdexLabs/ForgeLSP/releases/latest).  
Every download is SHA-256 verified. Binaries are stored in VS Code's global storage directory.

A background update check runs 10 seconds after startup and prompts if a newer version is available.

---

## Supported Platforms

| Platform | Architecture          |
| -------- | --------------------- |
| Linux    | x86-64                |
| Linux    | ARM64                 |
| macOS    | x86-64                |
| macOS    | Apple Silicon (ARM64) |
| Windows  | x86-64                |
