---
name: claude
description: Run Claude Code from inside Codex through the installed Claude in Codex plugin.
---

# Claude in Codex

Use this skill when you want Codex to call local Claude Code for the current task.

## What it does

This plugin adds a bundled `/claude` skill and forwards the request into the local `claude` CLI. It prefers a native local runner when one is available, then falls back to the portable Node bridge.

By default the runner uses a rich human-readable realtime mode that shows the delegated prompt, requested profile/model/effort, Claude session init, friendly progress lines such as Thinking or Bash, streamed assistant text, tool results, and the final completion summary while Claude works.

If you want the exact raw NDJSON stream that Claude CLI emits, set `"streamVisibility": "raw"` in the spec. If you want the older structured debug renderer, use `"streamVisibility": "trace"`.

## Good fits

- frontend and UI work
- second-opinion reviews
- planning and architecture passes
- debugging and investigation

## How it runs

1. Build a JSON spec file.
2. Put the workdir, profile, permission mode, prompt, and optional task context into it.
3. Run the installed bridge.
4. Review the result back in Codex.

## Example

### macOS / Linux

```bash
SPEC="${TMPDIR:-/tmp}/claude-in-codex.spec.json"
cat > "$SPEC" <<'JSON'
{
  "workdir": "/path/to/repo",
  "profile": "general",
  "permissionMode": "dontAsk",
  "streamVisibility": "events",
  "prompt": "Reply with exactly: HI_ONLY"
}
JSON

node <plugin-root>/scripts/claude-in-codex.mjs --spec-file "$SPEC"
```

### Windows PowerShell

```powershell
$spec = Join-Path $env:TEMP 'claude-in-codex.spec.json'
@{
  workdir = 'D:\YourRepo'
  profile = 'general'
  permissionMode = 'dontAsk'
  streamVisibility = 'events'
  prompt = 'Reply with exactly: HI_ONLY'
} | ConvertTo-Json -Depth 8 | Set-Content -Path $spec

node <plugin-root>\scripts\claude-in-codex.mjs --spec-file $spec
```

`<plugin-root>` depends on where the plugin is installed.

