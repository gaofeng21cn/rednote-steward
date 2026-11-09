# Installation

RedNote Steward runs locally on macOS with Node.js 24+ and Google Chrome. Its packaged OpenCLI dependency is pinned to 1.8.5; Browser Bridge is pinned to 1.0.26. An existing compatible browser connection can be reused.

## Install from GitHub

```bash
curl -fsSL https://raw.githubusercontent.com/gaofeng21cn/rednote-steward/main/install.sh | bash
```

The script installs the default release, currently `v0.1.0`, into your user directory. It installs dependencies, adds command wrappers, prepares Browser Bridge, installs the generic Codex Skill, and registers the MCP Server when Codex CLI is available. Node.js 24+ is required; the installer can use an existing Homebrew installation when Node needs installing.

The installed commands are:

- `xhs-ops`: account configuration, package inspection, queue operations, and platform reads.
- `rednote-steward-mcp`: the same operations through a standard STDIO MCP Server.

Add `export PATH="$HOME/.local/bin:$PATH"` to your shell startup file, or run it for the current terminal. The installer prints the remaining browser steps. Start a new Codex chat to discover the installed Skill and MCP tools.

## Connect Chrome and bind an account

1. Open `chrome://extensions`, enable Developer mode, and select **Load unpacked** with the Browser Bridge directory printed by setup. If a compatible extension is already connected, reuse it.
2. Open Xiaohongshu and its creator platform in that Chrome profile and sign in as the intended account holder.
3. Discover the connected profile, then read its current account identity:

```bash
xhs-ops opencli profile list
xhs-ops account probe --profile YOUR_PROFILE
```

4. Bind a local alias to the returned stable user ID and browser profile:

```bash
xhs-ops account add personal --user-id YOUR_USER_ID --profile YOUR_PROFILE
xhs-ops doctor --account personal
xhs-ops inventory --account personal --limit 20
```

Aliases are local names such as `personal` or `education`. The stable user ID determines account identity; the nickname is a display label. Each account uses its own profile. Login and device verification stay with the account holder in Chrome or the mobile app.

## MCP clients

The installer registers this server with Codex when available. To repair that registration and refresh the Skill:

```bash
xhs-ops setup --skill --mcp
```

For another MCP client, add a STDIO server using the absolute installed executable:

```json
{
  "mcpServers": {
    "rednote-steward": {
      "command": "/absolute/path/to/rednote-steward-mcp"
    }
  }
}
```

For a separate data directory, set `XHS_OPS_HOME` in the client environment and use the same value for CLI commands. This makes the client and shell use the same account bindings and task history.

The server exposes tools for account probing and binding, inventory and note reads, package inspection and ingestion, task authorization and execution, reconciliation, metrics, and inspection candidates. `task_execute` returns a task ID after starting a separate worker; read `task_get` for the outcome. The first release uses STDIO and structured tool results.

## Where files live

| Location | Contents |
| --- | --- |
| `~/.local/share/rednote-steward/app/releases/<version>/` | Installed code and dependencies |
| `~/.local/share/rednote-steward/app/current` | Selected installed release |
| `~/.local/bin/` | `xhs-ops` and `rednote-steward-mcp` wrappers |
| `~/.local/share/rednote-steward/` | Account bindings, SQLite state, receipts, worker logs, and installation record |
| `~/.codex/skills/rednote-steward/` | Generic assistant instructions |
| Your chosen content folder | Original media, derivatives, copy, and content packages |
| Chrome profile | Browser login and session data |

`XHS_OPS_HOME` selects the private state root. `XHS_OPS_INSTALL_ROOT` and `XHS_OPS_BIN_DIR` select installation and wrapper directories. An upgrade replaces application code while retaining task history and account settings.

## Update, repair, and remove

Read installation status:

```bash
xhs-ops setup --status
```

Refresh managed integrations:

```bash
xhs-ops setup --skill --mcp
```

Install a specific published version:

```bash
curl -fsSL https://raw.githubusercontent.com/gaofeng21cn/rednote-steward/main/install.sh \
  | bash -s -- --version v0.1.0
```

Run the packaged uninstaller to remove managed installation files and integrations:

```bash
bash "$HOME/.local/share/rednote-steward/app/current/scripts/uninstall.sh"
```

Private account state, task history, receipts, and media are retained. `xhs-ops setup --uninstall` removes only managed Skill/MCP integrations. Existing files that setup replaces are backed up; unrelated configuration is preserved.

## Existing xhs-ops workspaces

Install Steward alongside the original workspace first. Verify the new account binding and platform reads before transferring operational responsibility. Existing databases, JSON ledgers, active browser drafts, and authorization records remain with their current owner until deliberately migrated.

Use one queue for a live account. Before resuming an older task, check its current record and platform note ID in the original system. This release does not automatically import an older database or medical-video ledger. A new installation alone is not a reason to ingest already-published material again.

## Development install

```bash
git clone https://github.com/gaofeng21cn/rednote-steward.git
cd rednote-steward
npm ci
node src/cli.mjs help
npm test
```

For an isolated installer check, use its `--source PATH`, `--skip-browser-setup`, and `--skip-integrations` options with separate installation, binary, and state directories. Production browser sessions are unnecessary for this check.
