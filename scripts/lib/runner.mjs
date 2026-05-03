import { spawn } from 'node:child_process';
import readline from 'node:readline';

import {
  buildClaudeArguments,
  buildDelegatePrompt,
  buildNativeRunnerArguments,
  resolveNativeRunnerBin,
  shouldUseNativeRunner,
} from './command.mjs';

function extractAssistantText(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function extractToolResults(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content
    .filter((block) => block?.type === 'tool_result')
    .map((block) => ({
      toolUseId: block.tool_use_id ?? '',
      isError: Boolean(block.is_error),
      content: typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content ?? null),
    }));
}

function truncateForLog(value, maxLength = 280) {
  const normalized = typeof value === 'string' ? value : JSON.stringify(value);
  if (!normalized) return '';
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
}

function writeStructuredJsonLine(stdout, label, payload) {
  stdout.write(`[claude-in-codex:${label}] ${JSON.stringify(payload)}\n`);
}

function writeStructuredTextBlock(stdout, label, text) {
  stdout.write(`[claude-in-codex:${label}]\n${text}\n`);
}

function parseStructuredJson(input) {
  if (!input) return '';
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function formatDurationMs(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatCurrency(value) {
  if (!Number.isFinite(value)) return '';
  return `$${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '';
  return new Intl.NumberFormat('en-US').format(value);
}

function stringifySingleLine(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  try {
    return JSON.stringify(value).replace(/\s+/g, ' ').trim();
  } catch {
    return String(value).replace(/\s+/g, ' ').trim();
  }
}

function formatToolName(name = '') {
  if (!name) return 'Tool';
  if (name.startsWith('mcp__')) {
    const [, server = 'mcp', tool = 'tool'] = name.split('__');
    const prettyServer = server.replace(/[-_]/g, ' ');
    const prettyTool = tool.replace(/_/g, '-');
    return `MCP ${prettyServer}:${prettyTool}`;
  }
  const aliases = {
    AskUserQuestion: 'Ask',
    Bash: 'Bash',
    PowerShell: 'PowerShell',
    Read: 'Reading',
    Write: 'Writing',
    Edit: 'Editing',
    NotebookEdit: 'Editing',
    MultiEdit: 'Editing',
    Glob: 'Globbing',
    Grep: 'Searching',
    ToolSearch: 'Searching',
    WebSearch: 'WebSearch',
    WebFetch: 'WebFetch',
    Task: 'Task',
    TodoWrite: 'Todo',
    RemoteTrigger: 'RemoteTrigger',
    PushNotification: 'Notify',
  };
  return aliases[name] ?? name;
}

function extractToolActionSummary(name, input) {
  if (!input || typeof input !== 'object') return '';

  const fieldCandidates = [
    'command',
    'description',
    'file_path',
    'path',
    'url',
    'query',
    'pattern',
    'title',
    'task',
    'prompt',
    'content',
  ];

  for (const field of fieldCandidates) {
    const value = input[field];
    if (typeof value === 'string' && value.trim()) {
      return truncateForLog(value.trim(), field === 'content' ? 120 : 160);
    }
  }

  if (name === 'Read' && Array.isArray(input.files) && input.files.length > 0) {
    return truncateForLog(input.files.join(', '), 160);
  }

  return truncateForLog(input, 160);
}

function formatToolResultPreview(result) {
  const preview = truncateForLog(result.content ?? '', 220).trim();
  return preview || (result.isError ? 'Tool failed.' : 'Tool completed.');
}

function shouldUseAnsi(stdout) {
  return Boolean(stdout?.isTTY) && !process.env.NO_COLOR;
}

function paint(stdout, text, code) {
  if (!shouldUseAnsi(stdout) || !text) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

function prettyGlyph(stdout, glyph, colorCode = '97') {
  return paint(stdout, glyph, colorCode);
}

function formatUsageSummary(payload) {
  const usage = payload?.usage ?? {};
  const input = usage.input_tokens ?? payload?.modelUsage?.[Object.keys(payload?.modelUsage ?? {})[0]]?.inputTokens;
  const output = usage.output_tokens ?? payload?.modelUsage?.[Object.keys(payload?.modelUsage ?? {})[0]]?.outputTokens;
  const pieces = [];
  if (Number.isFinite(input)) pieces.push(`${formatNumber(input)} in`);
  if (Number.isFinite(output)) pieces.push(`${formatNumber(output)} out`);
  return pieces.join(' · ');
}

function createState() {
  return {
    sawVisibleOutput: false,
    activeTextBlockIndex: null,
    needsTrailingNewline: false,
    sawTextDelta: false,
    blocks: new Map(),
    pretty: {
      thinkingShownForMessage: false,
      textStartedForMessage: false,
      lastStatus: '',
    },
  };
}

function ensureStructuredTextStream(stdout, state, index) {
  if (state.activeTextBlockIndex === index) return;
  if (state.needsTrailingNewline) {
    stdout.write('\n');
    state.needsTrailingNewline = false;
  }
  stdout.write('[claude-in-codex:text]\n');
  state.activeTextBlockIndex = index;
}

function ensurePrettyTextStream(stdout, state, index) {
  if (state.activeTextBlockIndex === index) return;
  if (state.needsTrailingNewline) {
    stdout.write('\n');
    state.needsTrailingNewline = false;
  }
  state.activeTextBlockIndex = index;
}

function finalizeTextStream(stdout, state) {
  if (!state.needsTrailingNewline) return;
  stdout.write('\n');
  state.needsTrailingNewline = false;
  state.activeTextBlockIndex = null;
}

function writePrettyLine(stdout, text = '') {
  stdout.write(`${text}\n`);
}

function suppressBrokenPipeErrors(stream) {
  if (!stream || typeof stream.on !== 'function' || stream.__claudeInCodexPipeGuard) return;
  stream.__claudeInCodexPipeGuard = true;
  stream.on('error', (error) => {
    if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED') {
      return;
    }
    throw error;
  });
}

function printPrettyPrelude(spec, stdout) {
  writePrettyLine(stdout, `${prettyGlyph(stdout, '◆', '97;1')} ${paint(stdout, 'Claude in Codex', '97;1')}`);
  writePrettyLine(stdout, `${paint(stdout, 'Run', '90')} · ${spec.capabilityProfile} · ${spec.model} · ${spec.effort} · ${spec.permissionMode}`);
  writePrettyLine(stdout, `${paint(stdout, 'Workdir', '90')} · ${spec.workdir}`);
  writePrettyLine(stdout, `${paint(stdout, 'Prompt', '90')}`);
  writePrettyLine(stdout, buildDelegatePrompt(spec));
  writePrettyLine(stdout);
}

function renderSystemPayloadStructured(payload, stdout) {
  switch (payload.subtype) {
    case 'init':
      writeStructuredJsonLine(stdout, 'session-init', {
        sessionId: payload.session_id,
        cwd: payload.cwd,
        model: payload.model,
        permissionMode: payload.permissionMode,
        claudeCodeVersion: payload.claude_code_version,
        fastModeState: payload.fast_mode_state,
        outputStyle: payload.output_style,
        toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
        tools: payload.tools ?? [],
        mcpServers: payload.mcp_servers ?? [],
        slashCommands: payload.slash_commands ?? [],
        skills: payload.skills ?? [],
        plugins: payload.plugins ?? [],
      });
      return;
    case 'status':
      writeStructuredJsonLine(stdout, 'status', { status: payload.status, sessionId: payload.session_id });
      return;
    case 'hook_started':
      writeStructuredJsonLine(stdout, 'hook-started', {
        hookEvent: payload.hook_event,
        hookName: payload.hook_name,
        sessionId: payload.session_id,
      });
      return;
    case 'hook_response':
      writeStructuredTextBlock(stdout, 'hook-response', payload.output ?? '');
      return;
    default:
      writeStructuredJsonLine(stdout, `system-${payload.subtype ?? 'event'}`, payload);
  }
}

function renderSystemPayloadPretty(payload, state, stdout) {
  switch (payload.subtype) {
    case 'init': {
      const toolCount = Array.isArray(payload.tools) ? payload.tools.length : 0;
      const mcpCount = Array.isArray(payload.mcp_servers) ? payload.mcp_servers.length : 0;
      writePrettyLine(
        stdout,
        `${prettyGlyph(stdout, '●', '97')} ${paint(stdout, 'Claude Code ready', '97;1')} · ${payload.model ?? 'unknown model'} · ${toolCount} tools · ${mcpCount} MCP server${mcpCount === 1 ? '' : 's'}`,
      );
      return;
    }
    case 'status': {
      const status = payload.status ?? '';
      if (status && status !== state.pretty.lastStatus && status !== 'requesting') {
        writePrettyLine(stdout, `${prettyGlyph(stdout, '·', '90')} ${paint(stdout, 'Status', '90')} · ${status}`);
      }
      state.pretty.lastStatus = status;
      return;
    }
    case 'hook_started':
      writePrettyLine(stdout, `${prettyGlyph(stdout, '↳', '90')} ${paint(stdout, 'Hook', '90')} · ${payload.hook_name ?? payload.hook_event ?? 'started'}…`);
      return;
    case 'hook_response': {
      const response = truncateForLog(payload.output ?? '', 240);
      if (response) writePrettyLine(stdout, `  ${paint(stdout, 'Result', '90')} · ${response}`);
      return;
    }
    default:
      return;
  }
}

function renderStreamEventStructured(payload, state, stdout) {
  const event = payload.event ?? {};
  switch (event.type) {
    case 'message_start':
      writeStructuredJsonLine(stdout, 'message-start', {
        sessionId: payload.session_id,
        uuid: payload.uuid,
        ttftMs: payload.ttft_ms ?? null,
        model: event.message?.model ?? '',
        usage: event.message?.usage ?? null,
      });
      return;

    case 'content_block_start': {
      const block = event.content_block ?? {};
      if (block.type === 'text') {
        state.blocks.set(event.index, { type: 'text' });
        writeStructuredJsonLine(stdout, 'text-start', { index: event.index });
        return;
      }

      if (block.type === 'tool_use') {
        state.blocks.set(event.index, {
          type: 'tool_use',
          id: block.id ?? '',
          name: block.name ?? '',
          input: '',
        });
        writeStructuredJsonLine(stdout, 'tool-start', {
          index: event.index,
          id: block.id ?? '',
          name: block.name ?? '',
          caller: block.caller ?? null,
        });
        return;
      }

      if (block.type === 'thinking') {
        state.blocks.set(event.index, {
          type: 'thinking',
          thinking: block.thinking ?? '',
          signature: block.signature ?? '',
        });
        writeStructuredJsonLine(stdout, 'thinking-start', {
          index: event.index,
          hasSummary: Boolean(block.thinking),
          hasSignature: Boolean(block.signature),
          summary: block.thinking || '',
        });
        return;
      }

      state.blocks.set(event.index, { type: block.type ?? 'unknown' });
      writeStructuredJsonLine(stdout, 'content-start', { index: event.index, block });
      return;
    }

    case 'content_block_delta': {
      const delta = event.delta ?? {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        ensureStructuredTextStream(stdout, state, event.index);
        stdout.write(delta.text);
        state.sawVisibleOutput = true;
        state.sawTextDelta = true;
        state.needsTrailingNewline = true;
        return;
      }

      if (delta.type === 'input_json_delta') {
        const block = state.blocks.get(event.index);
        if (block?.type === 'tool_use') {
          block.input += delta.partial_json ?? '';
          writeStructuredJsonLine(stdout, 'tool-input-chunk', {
            index: event.index,
            id: block.id,
            name: block.name,
            chunk: delta.partial_json ?? '',
          });
          return;
        }
      }

      if (delta.type === 'signature_delta') {
        const block = state.blocks.get(event.index);
        if (block?.type === 'thinking') {
          block.signature += delta.signature ?? '';
          writeStructuredJsonLine(stdout, 'thinking-signature-chunk', {
            index: event.index,
            chunkLength: (delta.signature ?? '').length,
          });
          return;
        }
      }

      writeStructuredJsonLine(stdout, 'content-delta', {
        index: event.index,
        delta,
      });
      return;
    }

    case 'content_block_stop': {
      finalizeTextStream(stdout, state);
      const block = state.blocks.get(event.index);
      if (block?.type === 'tool_use') {
        writeStructuredJsonLine(stdout, 'tool-complete', {
          index: event.index,
          id: block.id,
          name: block.name,
          input: parseStructuredJson(block.input),
        });
      } else if (block?.type === 'thinking') {
        writeStructuredJsonLine(stdout, 'thinking-complete', {
          index: event.index,
          summary: block.thinking || '',
          signaturePresent: Boolean(block.signature),
          signatureLength: block.signature.length,
        });
      } else if (block?.type && block.type !== 'text') {
        writeStructuredJsonLine(stdout, 'content-complete', { index: event.index, type: block.type });
      }
      state.blocks.delete(event.index);
      return;
    }

    case 'message_delta':
      writeStructuredJsonLine(stdout, 'message-delta', event);
      return;

    case 'message_stop':
      writeStructuredJsonLine(stdout, 'message-stop', { sessionId: payload.session_id, uuid: payload.uuid });
      return;

    default:
      writeStructuredJsonLine(stdout, `stream-${event.type ?? 'event'}`, event);
  }
}

function renderStreamEventPretty(payload, state, stdout) {
  const event = payload.event ?? {};
  switch (event.type) {
    case 'message_start': {
      state.pretty.thinkingShownForMessage = false;
      state.pretty.textStartedForMessage = false;
      const model = event.message?.model ?? '';
      const usage = event.message?.usage;
      const modelInfo = model ? ` · ${model}` : '';
      const tier = usage?.service_tier ? ` · tier=${usage.service_tier}` : '';
      writePrettyLine(stdout, `${prettyGlyph(stdout, '◇', '97')} ${paint(stdout, 'Thinking…', '97;1')}${paint(stdout, `${modelInfo}${tier}`, '90')}`);
      state.pretty.thinkingShownForMessage = true;
      return;
    }

    case 'content_block_start': {
      const block = event.content_block ?? {};
      if (block.type === 'text') {
        state.blocks.set(event.index, { type: 'text' });
        return;
      }

      if (block.type === 'tool_use') {
        const prettyName = formatToolName(block.name ?? 'Tool');
        state.blocks.set(event.index, {
          type: 'tool_use',
          id: block.id ?? '',
          name: block.name ?? '',
          prettyName,
          input: '',
        });
        finalizeTextStream(stdout, state);
        writePrettyLine(stdout, `${prettyGlyph(stdout, '→', '96')} ${paint(stdout, `${prettyName}…`, '96;1')}`);
        return;
      }

      if (block.type === 'thinking') {
        state.blocks.set(event.index, {
          type: 'thinking',
          thinking: block.thinking ?? '',
          signature: block.signature ?? '',
        });
        if (!state.pretty.thinkingShownForMessage) {
          writePrettyLine(stdout, `${prettyGlyph(stdout, '◇', '97')} ${paint(stdout, 'Thinking…', '97;1')}`);
          state.pretty.thinkingShownForMessage = true;
        }
        const summary = stringifySingleLine(block.thinking);
        if (summary) writePrettyLine(stdout, `  ${paint(stdout, summary, '90')}`);
        return;
      }

      state.blocks.set(event.index, { type: block.type ?? 'unknown' });
      return;
    }

    case 'content_block_delta': {
      const delta = event.delta ?? {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        ensurePrettyTextStream(stdout, state, event.index);
        stdout.write(delta.text);
        state.sawVisibleOutput = true;
        state.sawTextDelta = true;
        state.pretty.textStartedForMessage = true;
        state.needsTrailingNewline = true;
        return;
      }

      if (delta.type === 'input_json_delta') {
        const block = state.blocks.get(event.index);
        if (block?.type === 'tool_use') {
          block.input += delta.partial_json ?? '';
          return;
        }
      }

      if (delta.type === 'thinking_delta') {
        const block = state.blocks.get(event.index);
        if (block?.type === 'thinking') {
          block.thinking += delta.thinking ?? '';
          return;
        }
      }

      if (delta.type === 'signature_delta') {
        const block = state.blocks.get(event.index);
        if (block?.type === 'thinking') {
          block.signature += delta.signature ?? '';
          return;
        }
      }
      return;
    }

    case 'content_block_stop': {
      finalizeTextStream(stdout, state);
      const block = state.blocks.get(event.index);
      if (block?.type === 'tool_use') {
        const parsedInput = parseStructuredJson(block.input);
        const summary = extractToolActionSummary(block.name, parsedInput);
        if (summary) writePrettyLine(stdout, `  ${paint(stdout, summary, '90')}`);
      } else if (block?.type === 'thinking') {
        const summary = stringifySingleLine(block.thinking);
        if (summary) writePrettyLine(stdout, `  ${paint(stdout, summary, '90')}`);
      }
      state.blocks.delete(event.index);
      return;
    }

    case 'message_delta':
      return;

    case 'message_stop':
      finalizeTextStream(stdout, state);
      return;

    default:
      return;
  }
}

function handleTextOnlyLine(line, state, stdout) {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    stdout.write(`${line}\n`);
    state.sawVisibleOutput = true;
    return;
  }

  if (payload.type === 'stream_event') {
    const event = payload.event;
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
      stdout.write(event.delta.text);
      state.sawVisibleOutput = true;
      state.needsTrailingNewline = true;
      return;
    }

    if (event?.type === 'content_block_stop' && state.needsTrailingNewline) {
      stdout.write('\n');
      state.needsTrailingNewline = false;
    }
    return;
  }

  if (payload.type === 'assistant') {
    const assistantText = extractAssistantText(payload.message);
    if (assistantText && !state.sawVisibleOutput) {
      stdout.write(`${assistantText}\n`);
      state.sawVisibleOutput = true;
    }
    return;
  }

  if (payload.type === 'result') {
    if (!state.sawVisibleOutput && typeof payload.result === 'string' && payload.result.trim()) {
      stdout.write(`${payload.result}\n`);
      state.sawVisibleOutput = true;
    } else if (state.needsTrailingNewline) {
      stdout.write('\n');
      state.needsTrailingNewline = false;
    }
  }
}

function handleEventLine(spec, line, state, stdout) {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    stdout.write(`${line}\n`);
    state.sawVisibleOutput = true;
    return;
  }

  if (payload.type === 'system') {
    if (!spec.includeHookEvents && ['hook_started', 'hook_response'].includes(payload.subtype)) {
      return;
    }
    if (spec.streamVisibility === 'trace') {
      renderSystemPayloadStructured(payload, stdout);
      return;
    }
    renderSystemPayloadPretty(payload, state, stdout);
    return;
  }

  if (payload.type === 'stream_event') {
    if (spec.streamVisibility === 'trace') {
      renderStreamEventStructured(payload, state, stdout);
      return;
    }
    renderStreamEventPretty(payload, state, stdout);
    return;
  }

  if (payload.type === 'assistant') {
    if (!state.sawTextDelta) {
      const assistantText = extractAssistantText(payload.message);
      if (assistantText) {
        if (spec.streamVisibility === 'trace') {
          writeStructuredTextBlock(stdout, 'assistant', assistantText);
        } else {
          finalizeTextStream(stdout, state);
          writePrettyLine(stdout, assistantText);
        }
        state.sawVisibleOutput = true;
      }
    }
    return;
  }

  if (payload.type === 'user') {
    const toolResults = extractToolResults(payload.message);
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        if (spec.streamVisibility === 'trace') {
          writeStructuredJsonLine(stdout, 'tool-result-meta', {
            toolUseId: result.toolUseId,
            isError: result.isError,
            preview: truncateForLog(result.content),
          });
          writeStructuredTextBlock(stdout, `tool-result:${result.toolUseId || 'unknown'}`, result.content);
        } else {
          finalizeTextStream(stdout, state);
          const label = result.isError ? `${prettyGlyph(stdout, '✕', '91')} ${paint(stdout, 'Error', '91;1')}` : `${prettyGlyph(stdout, '✓', '92')} ${paint(stdout, 'Result', '92;1')}`;
          writePrettyLine(stdout, `  ${label} · ${formatToolResultPreview(result)}`);
        }
      }
      return;
    }
    if (spec.streamVisibility === 'trace') {
      writeStructuredJsonLine(stdout, 'user-event', payload);
    }
    return;
  }

  if (payload.type === 'rate_limit_event') {
    if (spec.streamVisibility === 'trace') {
      writeStructuredJsonLine(stdout, 'rate-limit', payload.rate_limit_info ?? payload);
    }
    return;
  }

  if (payload.type === 'result') {
    if (spec.streamVisibility === 'trace') {
      writeStructuredJsonLine(stdout, 'result', {
        subtype: payload.subtype,
        durationMs: payload.duration_ms,
        durationApiMs: payload.duration_api_ms,
        numTurns: payload.num_turns,
        totalCostUsd: payload.total_cost_usd,
        stopReason: payload.stop_reason,
        terminalReason: payload.terminal_reason,
        usage: payload.usage ?? null,
        modelUsage: payload.modelUsage ?? null,
        permissionDenials: payload.permission_denials ?? [],
      });
    } else {
      finalizeTextStream(stdout, state);
      const parts = [
        payload.subtype === 'success' ? `${prettyGlyph(stdout, '✓', '92')} ${paint(stdout, 'Done', '92;1')}` : `${prettyGlyph(stdout, '•', '97')} ${paint(stdout, `Finished (${payload.subtype ?? 'result'})`, '97;1')}`,
      ];
      const duration = formatDurationMs(payload.duration_ms);
      if (duration) parts.push(duration);
      if (Number.isFinite(payload.num_turns)) parts.push(`${payload.num_turns} turn${payload.num_turns === 1 ? '' : 's'}`);
      const cost = formatCurrency(payload.total_cost_usd);
      if (cost) parts.push(cost);
      const usageSummary = formatUsageSummary(payload);
      if (usageSummary) parts.push(usageSummary);
      writePrettyLine(stdout, parts.join(' · '));
    }

    if (!state.sawVisibleOutput && typeof payload.result === 'string' && payload.result.trim()) {
      if (spec.streamVisibility === 'trace') {
        writeStructuredTextBlock(stdout, 'assistant', payload.result);
      } else {
        writePrettyLine(stdout, payload.result);
      }
      state.sawVisibleOutput = true;
    }
    return;
  }

  if (spec.streamVisibility === 'trace') {
    writeStructuredJsonLine(stdout, payload.type ?? 'event', payload);
  }
}

function printBridgePrelude(spec, stdout) {
  if (spec.streamVisibility === 'trace') {
    writeStructuredJsonLine(stdout, 'bridge-init', {
      workdir: spec.workdir,
      profile: spec.capabilityProfile,
      model: spec.model,
      effort: spec.effort,
      permissionMode: spec.permissionMode,
      outputFormat: spec.outputFormat,
      streamVisibility: spec.streamVisibility,
      includePartialMessages: spec.includePartialMessages,
      includeHookEvents: spec.includeHookEvents,
      verbose: spec.verbose,
    });
    writeStructuredTextBlock(stdout, 'prompt', buildDelegatePrompt(spec));
    return;
  }

  printPrettyPrelude(spec, stdout);
}

function quoteShellArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@%+\-\\]+$/.test(text)) return text;
  return `"${text.replaceAll('"', '\\"')}"`;
}

function spawnClaudeCommand(command, args, options) {
  if (process.platform !== 'win32') return spawn(command, args, { ...options, shell: false });
  return spawn([command, ...args].map(quoteShellArg).join(' '), { ...options, shell: true });
}

async function spawnClaudeProcess(spec, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  suppressBrokenPipeErrors(stdout);
  suppressBrokenPipeErrors(stderr);
  const child = spawnClaudeCommand(spec.claudeBin, buildClaudeArguments(spec), {
    cwd: spec.workdir,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const timeout = setTimeout(() => {
    stderr.write(`[claude-in-codex] timed out after ${spec.maxTimeoutMs}ms\n`);
    child.kill();
  }, spec.maxTimeoutMs);

  return {
    stdout,
    stderr,
    child,
    timeout,
  };
}

async function spawnNativeRunnerProcess(spec, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  suppressBrokenPipeErrors(stdout);
  suppressBrokenPipeErrors(stderr);
  const child = spawn(spec.nativeRunnerBin, buildNativeRunnerArguments(spec), {
    cwd: spec.workdir,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const timeout = setTimeout(() => {
    stderr.write(`[claude-in-codex] native runner timed out after ${spec.maxTimeoutMs}ms\n`);
    child.kill();
  }, spec.maxTimeoutMs);

  return {
    stdout,
    stderr,
    child,
    timeout,
  };
}

async function runRawClaudeInCodex(spec, io = {}) {
  const { stdout, stderr, child, timeout } = await spawnClaudeProcess(spec, io);
  child.stdout.on('data', (chunk) => stdout.write(chunk));
  child.stderr.on('data', (chunk) => stderr.write(chunk));

  return await new Promise((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(code ?? 0);
        return;
      }
      reject(new Error(`Claude in Codex exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function runNativeClaudeInCodex(spec, io = {}) {
  const { stdout, stderr, child, timeout } = await spawnNativeRunnerProcess(spec, io);
  child.stdout.on('data', (chunk) => stdout.write(chunk));
  child.stderr.on('data', (chunk) => stderr.write(chunk));

  return await new Promise((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(code ?? 0);
        return;
      }
      reject(new Error(`Claude in Codex native runner exited with code ${code ?? 'unknown'}`));
    });
  });
}

export async function runClaudeInCodex(spec, io = {}) {
  if (shouldUseNativeRunner(spec)) {
    return runNativeClaudeInCodex(spec, io);
  }

  if (spec.streamVisibility === 'raw') {
    return runRawClaudeInCodex(spec, io);
  }

  const { stdout, stderr, child, timeout } = await spawnClaudeProcess(spec, io);
  const state = createState();

  if (spec.streamVisibility === 'events' || spec.streamVisibility === 'trace') {
    printBridgePrelude(spec, stdout);
  }

  const stdoutLines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdoutLines.on('line', (line) => {
    if (spec.streamVisibility === 'text') {
      handleTextOnlyLine(line, state, stdout);
      return;
    }
    handleEventLine(spec, line, state, stdout);
  });

  child.stderr.on('data', (chunk) => stderr.write(chunk));

  return await new Promise((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.once('close', (code) => {
      clearTimeout(timeout);
      finalizeTextStream(stdout, state);
      if (code === 0) {
        resolve(code ?? 0);
        return;
      }
      reject(new Error(`Claude in Codex exited with code ${code ?? 'unknown'}`));
    });
  });
}

export async function runDoctor(spec = {}) {
  const stdout = spec.stdout ?? process.stdout;
  const stderr = spec.stderr ?? process.stderr;
  const nativeRunnerBin = resolveNativeRunnerBin(spec.nativeRunnerBin);
  const child = spawnClaudeCommand(spec.claudeBin ?? process.env.CLAUDE_BIN ?? 'claude', ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let collectedStdout = '';
  let collectedStderr = '';
  child.stdout.on('data', (chunk) => { collectedStdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { collectedStderr += chunk.toString(); });

  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });

  const report = {
    node: process.version,
    claudeBin: spec.claudeBin ?? process.env.CLAUDE_BIN ?? 'claude',
    nativeRunnerBin,
    claudeVersion: collectedStdout.trim(),
    exitCode,
  };

  if (exitCode === 0) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  stderr.write(`${JSON.stringify({ ...report, stderr: collectedStderr.trim() }, null, 2)}\n`);
  return exitCode;
}

