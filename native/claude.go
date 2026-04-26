package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type config struct {
	Workdir           string
	Profile           string
	PermissionMode    string
	OutputFormat      string
	Model             string
	Effort            string
	ClaudeBin         string
	Prompt            string
	BypassPermissions bool
	AdditionalDirs    []string
	Timeout           time.Duration
}

type blockState struct {
	Type       string
	Name       string
	ID         string
	Input      strings.Builder
	Thinking   strings.Builder
	TextActive bool
}

type streamState struct {
	Blocks        map[int]*blockState
	TextLineStart bool
	LastStatus    string
	SawText       bool
}

func main() {
	cfg, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "[claude] fatal: %v\n", err)
		os.Exit(2)
	}

	if err := run(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "[claude] fatal: %v\n", err)
		os.Exit(1)
	}
}

func parseArgs(args []string) (config, error) {
	cfg := config{
		Profile:        "general",
		PermissionMode: "acceptEdits",
		OutputFormat:   "text",
		Model:          "opus",
		Effort:         "high",
		ClaudeBin:      "claude",
		Timeout:        defaultTimeout(),
	}

	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch arg {
		case "--help", "-h":
			printHelp()
			os.Exit(0)
		case "--version", "-v":
			fmt.Println("claude-for-codex-native/0.1.0")
			os.Exit(0)
		case "--":
			cfg.Prompt = strings.Join(args[i+1:], " ")
			i = len(args)
		case "--workdir":
			value, next, err := takeValue(args, i, arg)
			if err != nil {
				return cfg, err
			}
			cfg.Workdir, i = value, next
		case "--capability-profile", "--profile":
			value, next, err := takeValue(args, i, arg)
			if err != nil {
				return cfg, err
			}
			cfg.Profile, i = value, next
		case "--permission-mode":
			value, next, err := takeValue(args, i, arg)
			if err != nil {
				return cfg, err
			}
			cfg.PermissionMode, i = value, next
		case "--output-format":
			value, next, err := takeValue(args, i, arg)
			if err != nil {
				return cfg, err
			}
			cfg.OutputFormat, i = value, next
		case "--model":
			value, next, err := takeValue(args, i, arg)
			if err != nil {
				return cfg, err
			}
			cfg.Model, i = value, next
		case "--effort", "--reasoning-effort":
			value, next, err := takeValue(args, i, arg)
			if err != nil {
				return cfg, err
			}
			cfg.Effort, i = value, next
		case "--claude-bin":
			value, next, err := takeValue(args, i, arg)
			if err != nil {
				return cfg, err
			}
			cfg.ClaudeBin, i = value, next
		case "--add-dir":
			value, next, err := takeValue(args, i, arg)
			if err != nil {
				return cfg, err
			}
			cfg.AdditionalDirs = append(cfg.AdditionalDirs, value)
			i = next
		case "--bypass-permissions", "--dangerously-skip-permissions":
			cfg.BypassPermissions = true
		case "--timeout-ms":
			value, next, err := takeValue(args, i, arg)
			if err != nil {
				return cfg, err
			}
			ms, err := strconv.Atoi(value)
			if err != nil || ms <= 0 {
				return cfg, fmt.Errorf("invalid --timeout-ms: %s", value)
			}
			cfg.Timeout, i = time.Duration(ms)*time.Millisecond, next
		default:
			cfg.Prompt = strings.Join(args[i:], " ")
			i = len(args)
		}
	}

	cfg.Workdir = strings.TrimSpace(cfg.Workdir)
	cfg.Prompt = strings.TrimSpace(cfg.Prompt)
	if cfg.Workdir == "" {
		return cfg, errors.New("missing --workdir")
	}
	if cfg.Prompt == "" {
		return cfg, errors.New("missing prompt")
	}
	if _, err := os.Stat(cfg.Workdir); err != nil {
		return cfg, fmt.Errorf("workdir unavailable: %w", err)
	}
	abs, err := filepath.Abs(cfg.Workdir)
	if err == nil {
		cfg.Workdir = abs
	}
	return cfg, nil
}

func takeValue(args []string, index int, flag string) (string, int, error) {
	if index+1 >= len(args) {
		return "", index, fmt.Errorf("%s requires a value", flag)
	}
	return args[index+1], index + 1, nil
}

func defaultTimeout() time.Duration {
	value := strings.TrimSpace(os.Getenv("CLAUDE_FOR_CODEX_TIMEOUT_MS"))
	if value == "" {
		return 20 * time.Minute
	}
	ms, err := strconv.Atoi(value)
	if err != nil || ms <= 0 {
		return 20 * time.Minute
	}
	return time.Duration(ms) * time.Millisecond
}

func printHelp() {
	fmt.Println("claude.exe --workdir <repo> --capability-profile <profile> --permission-mode <mode> --model <model> --effort <effort> --claude-bin <claude> [--add-dir <dir>] [--bypass-permissions] [--] <prompt>")
}

func run(cfg config) error {
	printPrelude(cfg)

	ctx, cancel := context.WithTimeout(context.Background(), cfg.Timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, cfg.ClaudeBin, buildClaudeArgs(cfg)...)
	cmd.Dir = cfg.Workdir
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start %q: %w", cfg.ClaudeBin, err)
	}

	done := make(chan error, 2)
	go func() { done <- consumeClaudeStdout(stdout) }()
	go func() { done <- consumePrefixed(stderr, "[claude:stderr]") }()

	var streamErr error
	for range 2 {
		if err := <-done; err != nil && streamErr == nil {
			streamErr = err
		}
	}

	waitErr := cmd.Wait()
	if ctx.Err() == context.DeadlineExceeded {
		return fmt.Errorf("timed out after %s", cfg.Timeout)
	}
	if streamErr != nil {
		return streamErr
	}
	if waitErr != nil {
		return waitErr
	}
	return nil
}

func buildClaudeArgs(cfg config) []string {
	args := []string{
		"-p",
		"--model", cfg.Model,
		"--effort", mapEffortForClaude(cfg.Effort),
		"--output-format", "stream-json",
		"--permission-mode", cfg.PermissionMode,
		"--append-system-prompt", systemPrompt(cfg.Profile),
		"--include-partial-messages",
		"--include-hook-events",
		"--verbose",
	}
	if cfg.BypassPermissions && cfg.PermissionMode != "bypassPermissions" {
		args = append(args, "--dangerously-skip-permissions")
	}
	if disallowed := disallowedTools(cfg.Profile); disallowed != "" {
		args = append(args, "--disallowedTools", disallowed)
	}
	for _, dir := range cfg.AdditionalDirs {
		if strings.TrimSpace(dir) != "" {
			args = append(args, "--add-dir", dir)
		}
	}
	args = append(args, "--", cfg.Prompt)
	return args
}

func mapEffortForClaude(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch normalized {
	case "", "medium":
		return "medium"
	case "max", "xhigh":
		return "xhigh"
	default:
		return normalized
	}
}

func systemPrompt(profile string) string {
	shared := "Keep progress externally legible. Emit concise status updates when inspecting, using tools, editing, validating, or changing direction. Prefer direct useful work over padded ideation. Do not write plan files unless asked."
	switch strings.ToLower(profile) {
	case "design":
		return "You are a senior frontend/UI specialist. Own visual design, layout, interaction polish, accessibility, responsiveness, and frontend-facing implementation only unless asked otherwise. " + shared
	case "ui-audit":
		return "You are a senior UI auditor. Stay read-only unless asked to edit. Focus on evidence-backed UX, accessibility, responsiveness, hierarchy, and visual polish findings. " + shared
	case "review":
		return "You are a senior code reviewer. Stay read-only unless asked to edit. Find real correctness, security, performance, regression, and maintainability issues with evidence. " + shared
	case "plan":
		return "You are a senior planner and architect. Stay read-only. Produce an implementation-ready plan grounded in repository evidence, risks, ordering, and validation. " + shared
	case "challenge":
		return "You are a senior debugging specialist. Investigate ambiguous failures, narrow hypotheses with evidence, and identify the best next action. " + shared
	case "explore":
		return "You are a fast repository exploration specialist. Stay read-only. Map structure, files, symbols, and likely ownership concisely. " + shared
	default:
		return "You are a senior generalist engineer. Handle the delegated slice directly with clear progress and strong validation. " + shared
	}
}

func disallowedTools(profile string) string {
	switch strings.ToLower(profile) {
	case "ui-audit":
		return "Write,Edit,MultiEdit,NotebookEdit,Bash,ExitPlanMode"
	case "review", "plan", "explore":
		return "Write,Edit,MultiEdit,NotebookEdit"
	default:
		return ""
	}
}

func printPrelude(cfg config) {
	line("Model: %s ~ Reasoning Effort: %s ~ Permission: %s ~ Profile: %s", cfg.Model, cfg.Effort, cfg.PermissionMode, cfg.Profile)
	line("Workdir: %s", cfg.Workdir)
	if len(cfg.AdditionalDirs) > 0 {
		line("Additional dirs: %s", strings.Join(cfg.AdditionalDirs, ", "))
	}
	line("Prompt:")
	for _, promptLine := range strings.Split(cfg.Prompt, "\n") {
		fmt.Printf("[claude]   %s\n", promptLine)
	}
	line("Starting Claude Code...")
}

func consumeClaudeStdout(reader io.Reader) error {
	state := streamState{Blocks: map[int]*blockState{}, TextLineStart: true}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	for scanner.Scan() {
		handleLine(scanner.Text(), &state)
	}
	if !state.TextLineStart {
		fmt.Println()
	}
	return scanner.Err()
}

func consumePrefixed(reader io.Reader, prefix string) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	for scanner.Scan() {
		text := strings.TrimRight(scanner.Text(), "\r\n")
		if text != "" {
			fmt.Printf("%s %s\n", prefix, text)
		}
	}
	return scanner.Err()
}

func handleLine(raw string, state *streamState) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		line("raw: %s", raw)
		return
	}

	switch stringValue(payload["type"]) {
	case "system":
		handleSystem(payload, state)
	case "stream_event":
		handleStreamEvent(payload, state)
	case "assistant":
		handleAssistant(payload, state)
	case "user":
		handleUser(payload)
	case "result":
		handleResult(payload)
	case "rate_limit_event":
		line("Rate limit event: %s", oneLine(payload["rate_limit_info"], 220))
	default:
		line("Event %s: %s", stringValue(payload["type"]), oneLine(payload, 220))
	}
}

func handleSystem(payload map[string]any, state *streamState) {
	subtype := stringValue(payload["subtype"])
	switch subtype {
	case "init":
		tools := len(arrayValue(payload["tools"]))
		mcp := len(arrayValue(payload["mcp_servers"]))
		line("Claude Code ready: model=%s cwd=%s tools=%d mcp_servers=%d version=%s", stringValue(payload["model"]), stringValue(payload["cwd"]), tools, mcp, stringValue(payload["claude_code_version"]))
	case "status":
		status := stringValue(payload["status"])
		if status != "" && status != state.LastStatus && status != "requesting" {
			line("Status: %s", status)
		}
		state.LastStatus = status
	case "hook_started":
		line("Hook started: %s %s", stringValue(payload["hook_event"]), stringValue(payload["hook_name"]))
	case "hook_response":
		line("Hook response: %s", truncate(stringValue(payload["output"]), 260))
	default:
		line("System %s: %s", subtype, oneLine(payload, 260))
	}
}

func handleStreamEvent(payload map[string]any, state *streamState) {
	event := mapValue(payload["event"])
	switch stringValue(event["type"]) {
	case "message_start":
		message := mapValue(event["message"])
		line("Thinking... model=%s usage=%s", stringValue(message["model"]), oneLine(message["usage"], 180))
	case "content_block_start":
		index := intValue(event["index"])
		block := mapValue(event["content_block"])
		switch stringValue(block["type"]) {
		case "text":
			state.Blocks[index] = &blockState{Type: "text", TextActive: true}
			state.TextLineStart = true
		case "tool_use":
			name := stringValue(block["name"])
			id := stringValue(block["id"])
			state.Blocks[index] = &blockState{Type: "tool_use", Name: name, ID: id}
			line("Tool call started: %s%s", prettyToolName(name), optionalID(id))
		case "thinking":
			state.Blocks[index] = &blockState{Type: "thinking"}
			line("Thinking block started")
			if summary := strings.TrimSpace(stringValue(block["thinking"])); summary != "" {
				line("Thinking: %s", truncate(summary, 300))
			}
		default:
			state.Blocks[index] = &blockState{Type: stringValue(block["type"])}
			line("Content block started: %s", stringValue(block["type"]))
		}
	case "content_block_delta":
		index := intValue(event["index"])
		delta := mapValue(event["delta"])
		block := state.Blocks[index]
		switch stringValue(delta["type"]) {
		case "text_delta":
			state.SawText = true
			writePrefixedText("[claude] assistant: ", stringValue(delta["text"]), &state.TextLineStart)
		case "input_json_delta":
			if block != nil {
				block.Input.WriteString(stringValue(delta["partial_json"]))
			}
		case "thinking_delta":
			if block != nil {
				block.Thinking.WriteString(stringValue(delta["thinking"]))
			}
		case "signature_delta":
		default:
			line("Delta %s: %s", stringValue(delta["type"]), oneLine(delta, 180))
		}
	case "content_block_stop":
		if !state.TextLineStart {
			fmt.Println()
			state.TextLineStart = true
		}
		index := intValue(event["index"])
		block := state.Blocks[index]
		if block != nil {
			switch block.Type {
			case "tool_use":
				lineTool(block)
			case "thinking":
				if text := strings.TrimSpace(block.Thinking.String()); text != "" {
					line("Thinking summary: %s", truncate(strings.Join(strings.Fields(text), " "), 400))
				} else {
					line("Thinking block complete")
				}
			}
			delete(state.Blocks, index)
		}
	case "message_delta":
		line("Message delta: %s", oneLine(event["delta"], 180))
	case "message_stop":
		if !state.TextLineStart {
			fmt.Println()
			state.TextLineStart = true
		}
		line("Message complete")
	default:
		line("Stream event %s: %s", stringValue(event["type"]), oneLine(event, 220))
	}
}

func handleAssistant(payload map[string]any, state *streamState) {
	if state.SawText {
		return
	}
	message := mapValue(payload["message"])
	for _, item := range arrayValue(message["content"]) {
		block := mapValue(item)
		if stringValue(block["type"]) == "text" && stringValue(block["text"]) != "" {
			line("assistant:")
			for _, l := range strings.Split(stringValue(block["text"]), "\n") {
				fmt.Printf("[claude]   %s\n", l)
			}
		}
	}
}

func handleUser(payload map[string]any) {
	message := mapValue(payload["message"])
	for _, item := range arrayValue(message["content"]) {
		block := mapValue(item)
		if stringValue(block["type"]) == "tool_result" {
			prefix := "Tool result"
			if boolValue(block["is_error"]) {
				prefix = "Tool error"
			}
			line("%s: %s", prefix, truncate(oneLine(block["content"], 320), 320))
		}
	}
}

func handleResult(payload map[string]any) {
	line("Done: subtype=%s duration=%s turns=%s cost=%s stop=%s", stringValue(payload["subtype"]), durationString(payload["duration_ms"]), numberString(payload["num_turns"]), costString(payload["total_cost_usd"]), stringValue(payload["stop_reason"]))
	if result := strings.TrimSpace(stringValue(payload["result"])); result != "" {
		line("Final result:")
		for _, l := range strings.Split(result, "\n") {
			fmt.Printf("[claude]   %s\n", l)
		}
	}
}

func lineTool(block *blockState) {
	input := parseJSON(block.Input.String())
	name := block.Name
	summary := summarizeToolInput(name, input)
	if strings.HasPrefix(name, "mcp__") {
		line("MCP tool call: %s%s", prettyToolName(name), summarySuffix(summary))
		return
	}
	switch name {
	case "Bash", "PowerShell":
		line("bash: %s", summary)
	case "Read":
		line("reading: %s", summary)
	case "Write":
		line("writing: %s", summary)
	case "Edit", "MultiEdit", "NotebookEdit":
		line("editing: %s", summary)
	case "Glob":
		line("glob: %s", summary)
	case "Grep":
		line("grep: %s", summary)
	case "Task":
		line("task/subagent: %s", summary)
	case "TodoWrite":
		line("todo update: %s", summary)
	default:
		line("tool: %s%s", prettyToolName(name), summarySuffix(summary))
	}
}

func summarizeToolInput(name string, input any) string {
	m := mapValue(input)
	fields := []string{"description", "command", "file_path", "path", "url", "query", "pattern", "title", "task", "prompt"}
	for _, field := range fields {
		if value := strings.TrimSpace(stringValue(m[field])); value != "" {
			return truncate(value, 240)
		}
	}
	if name == "TodoWrite" {
		if todos := arrayValue(m["todos"]); len(todos) > 0 {
			return fmt.Sprintf("%d todos", len(todos))
		}
	}
	return truncate(oneLine(input, 240), 240)
}

func prettyToolName(name string) string {
	if strings.HasPrefix(name, "mcp__") {
		parts := strings.Split(name, "__")
		if len(parts) >= 3 {
			return fmt.Sprintf("MCP %s.%s", parts[1], parts[2])
		}
		return "MCP " + name
	}
	switch name {
	case "Read":
		return "Read"
	case "Write":
		return "Write"
	case "Edit", "MultiEdit", "NotebookEdit":
		return "Edit"
	case "Bash", "PowerShell":
		return "Shell"
	case "Glob":
		return "Glob"
	case "Grep":
		return "Grep"
	case "Task":
		return "Subagent"
	case "TodoWrite":
		return "TodoWrite"
	default:
		if name == "" {
			return "Tool"
		}
		return name
	}
}

func writePrefixedText(prefix, text string, atLineStart *bool) {
	for len(text) > 0 {
		if *atLineStart {
			fmt.Print(prefix)
			*atLineStart = false
		}
		idx := strings.IndexByte(text, '\n')
		if idx < 0 {
			fmt.Print(text)
			return
		}
		fmt.Print(text[:idx+1])
		*atLineStart = true
		text = text[idx+1:]
	}
}

func line(format string, args ...any) { fmt.Printf("[claude] "+format+"\n", args...) }

func optionalID(id string) string {
	if id == "" {
		return ""
	}
	return " id=" + id
}
func summarySuffix(summary string) string {
	if summary == "" {
		return ""
	}
	return ": " + summary
}

func parseJSON(value string) any {
	if strings.TrimSpace(value) == "" {
		return map[string]any{}
	}
	var parsed any
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return value
	}
	return parsed
}

func mapValue(value any) map[string]any {
	if typed, ok := value.(map[string]any); ok {
		return typed
	}
	return map[string]any{}
}

func arrayValue(value any) []any {
	if typed, ok := value.([]any); ok {
		return typed
	}
	return nil
}

func stringValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case bool:
		if typed {
			return "true"
		}
		return "false"
	default:
		return ""
	}
}

func boolValue(value any) bool {
	if typed, ok := value.(bool); ok {
		return typed
	}
	return false
}

func intValue(value any) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case json.Number:
		v, _ := typed.Int64()
		return int(v)
	case int:
		return typed
	default:
		return 0
	}
}

func oneLine(value any, max int) string {
	if s, ok := value.(string); ok {
		return truncate(strings.Join(strings.Fields(s), " "), max)
	}
	bytes, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return truncate(strings.Join(strings.Fields(string(bytes)), " "), max)
}

func truncate(value string, max int) string {
	if max <= 0 || len(value) <= max {
		return value
	}
	if max <= 1 {
		return value[:max]
	}
	return value[:max-1] + "…"
}

func durationString(value any) string {
	ms := floatValue(value)
	if ms <= 0 {
		return ""
	}
	if ms < 1000 {
		return fmt.Sprintf("%.0fms", ms)
	}
	return fmt.Sprintf("%.1fs", ms/1000)
}

func costString(value any) string {
	cost := floatValue(value)
	if cost <= 0 {
		return ""
	}
	return fmt.Sprintf("$%.6f", cost)
}

func numberString(value any) string {
	n := floatValue(value)
	if n == 0 {
		return ""
	}
	return strconv.Itoa(int(n))
}

func floatValue(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case json.Number:
		v, _ := typed.Float64()
		return v
	default:
		return 0
	}
}
