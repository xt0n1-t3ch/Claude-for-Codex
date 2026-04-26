---
name: claude
description: Run Claude Code from inside Codex through the installed Claude in Codex plugin.
---

# Claude in Codex

Use this skill when Codex or OpenCode should call local Claude Code for the current task without leaving the current terminal workflow.

## What it does

This plugin adds a `/claude` skill and forwards the request into the local `claude` CLI. It prefers Tony's native local runner when one is available, then falls back to the portable Node bridge.

By default the runner uses a rich human-readable realtime mode that shows the delegated prompt, requested profile/model/effort, Claude session init, friendly progress lines such as Thinking or Bash, streamed assistant text, tool results, and the final completion summary while Claude works.

If you want the exact raw NDJSON stream that Claude CLI emits, set `"streamVisibility": "raw"` in the spec. If you want the older structured debug renderer, use `"streamVisibility": "trace"`.

## Installed paths

- Installed plugin bridge: `<plugin-root>\scripts\claude-in-codex.mjs`
- Auto-detected Windows native runner: `%USERPROFILE%\.codex\tools\claude\target\release\claude.exe`
- Source checkout native runner after `npm run build:native`: `<repo-root>\target\release\claude.exe`

The installer builds the native runner when Go is available. The Node bridge auto-detects the real Codex runner path above. To force another runner for a one-off task, include `"nativeRunnerBin": "<path-to-claude.exe>"` in the JSON spec.

## Good fits

- frontend and UI work
- second-opinion reviews
- planning and architecture passes
- debugging and investigation
- challenge/root-cause passes where Opus should inspect a bounded slice

## How it runs

1. Build a JSON spec file.
2. Put the workdir, profile, permission mode, prompt, and optional task context into it.
3. Run the bridge with `node ...\claude-in-codex.mjs --spec-file <spec>`.
4. Watch the realtime `[claude]` or `Claude in Codex` trace while Claude works.
5. Review the result back in Codex/OpenCode and continue the main task yourself.

## Profiles

- `design`: frontend/UI implementation lane.
- `ui-audit`: read-only UI/UX/a11y/responsive audit.
- `review`: read-only code review and second opinion.
- `plan`: read-only architecture or implementation plan.
- `challenge`: debugging/root-cause investigation.
- `general`: broad Claude Code execution.
- `explore`: fast read-only repo exploration.

`ui-audit`, `review`, `plan`, and `explore` force read-only behavior through permission/tool restrictions. Use `general` or `design` when edits are intentionally delegated.

## Spec fields

- `workdir`: repository or workspace path Claude should run in.
- `prompt`: the delegated task.
- `profile` or `capabilityProfile`: one of the profiles above.
- `permissionMode`: usually `dontAsk` for read-only or `acceptEdits` for implementation.
- `streamVisibility`: `events` for friendly realtime output, `trace` for structured debug output, `raw` for exact Claude CLI NDJSON, or `text` for assistant text only.
- `model`: defaults by profile; override only when needed.
- `effort`: defaults by profile; `xhigh` maps through the bridge for the native runner.
- `taskContext`: compact handoff context when delegating a slice.
- `additionalDirectories`: optional extra directories forwarded with `--add-dir`.
- `nativeRunnerBin`: optional explicit path to `claude.exe`.
- `maxTimeoutMs`: timeout for the bridge process.

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

## Realtime trace expectations

Friendly/native runs should show the profile/model/effort/permission, workdir, delegated prompt, Claude Code session readiness, thinking/status lines, tool calls, MCP calls, shell/read/write/edit summaries, tool results, assistant text, stderr if Claude emits it, timeout failures, and final completion metadata. Do not promise hidden chain-of-thought; only display the summaries and events exposed by Claude CLI.

