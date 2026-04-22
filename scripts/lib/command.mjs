import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildSystemPrompt,
  defaultEffortForProfile,
  defaultModelForProfile,
  disallowedToolsForProfile,
  effectivePermissionMode,
  internalOutputFormat,
  normalizeCapabilityProfile,
  shouldIncludePartialMessages,
} from './profiles.mjs';

function asCleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return Boolean(value);
}

function normalizeStreamVisibility(value = 'events') {
  const normalized = asCleanString(value).toLowerCase() || 'events';
  if (['text', 'events', 'trace', 'raw'].includes(normalized)) return normalized;
  throw new Error(`Unsupported streamVisibility: ${value}`);
}

function detectNativeRunnerBin() {
  if (process.platform === 'win32') {
    const candidate = path.join(os.homedir(), '.codex', 'tools', 'claude', 'target', 'release', 'claude.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

export function resolveNativeRunnerBin(value) {
  const explicit = asCleanString(value);
  if (explicit) return explicit;

  const fromEnv = asCleanString(process.env.CLAUDE_IN_CODEX_NATIVE_RUNNER ?? process.env.CLAUDE_NATIVE_RUNNER);
  if (fromEnv) return fromEnv;

  return detectNativeRunnerBin();
}

export function mapEffortForNativeRunner(value = '') {
  const normalized = asCleanString(value).toLowerCase();
  if (!normalized) return 'medium';
  if (normalized === 'xhigh') return 'max';
  if (normalized === 'max') return 'max';
  return normalized;
}

export function resolveInvocationSpec(input = {}) {
  const prompt = asCleanString(input.prompt);
  if (!prompt) throw new Error('Invocation spec must include a non-empty prompt.');

  const workdir = asCleanString(input.workdir);
  if (!workdir) throw new Error('Invocation spec must include a workdir.');

  const capabilityProfile = normalizeCapabilityProfile(input.capabilityProfile ?? input.profile ?? 'design');
  const model = asCleanString(input.model) || defaultModelForProfile(capabilityProfile);
  const effort = asCleanString(input.effort) || defaultEffortForProfile(capabilityProfile);
  const permissionMode = asCleanString(input.permissionMode) || 'acceptEdits';
  const outputFormat = asCleanString(input.outputFormat) || 'stream-json';
  const streamVisibility = normalizeStreamVisibility(input.streamVisibility ?? input.realtimeMode ?? 'events');

  return {
    prompt,
    workdir,
    capabilityProfile,
    model,
    effort,
    permissionMode,
    outputFormat,
    streamVisibility,
    claudeBin: asCleanString(input.claudeBin) || process.env.CLAUDE_BIN || 'claude',
    additionalDirectories: asStringArray(input.additionalDirectories),
    bypassPermissions: Boolean(input.bypassPermissions),
    fallbackOrigin: asCleanString(input.fallbackOrigin),
    fallbackReason: asCleanString(input.fallbackReason),
    taskContext: typeof input.taskContext === 'string' ? input.taskContext.trim() : '',
    useBare: Boolean(input.useBare),
    includePartialMessages: input.includePartialMessages ?? shouldIncludePartialMessages(outputFormat),
    includeHookEvents: asBoolean(input.includeHookEvents, streamVisibility === 'raw'),
    verbose: asBoolean(input.verbose, false),
    showCommand: Boolean(input.showCommand),
    preferNativeRunner: asBoolean(input.preferNativeRunner, true),
    nativeRunnerBin: resolveNativeRunnerBin(input.nativeRunnerBin),
    maxTimeoutMs: Number.isFinite(input.maxTimeoutMs) && Number(input.maxTimeoutMs) > 0 ? Number(input.maxTimeoutMs) : 20 * 60 * 1000,
  };
}

export function buildDelegatePrompt(spec) {
  if (!spec.taskContext && !spec.fallbackOrigin && !spec.fallbackReason) return spec.prompt;

  const sections = [];
  if (spec.taskContext) {
    sections.push('Task context:');
    sections.push(spec.taskContext);
    sections.push('');
  }
  if (spec.fallbackOrigin || spec.fallbackReason) {
    sections.push('Fallback handoff context:');
    if (spec.fallbackOrigin) sections.push(`- origin: ${spec.fallbackOrigin}`);
    if (spec.fallbackReason) sections.push(`- reason: ${spec.fallbackReason}`);
    sections.push('Continue the task immediately, keep progress visible, and use this handoff context as the reason you are being invoked.');
    sections.push('');
  }
  sections.push('Task:');
  sections.push(spec.prompt);
  return sections.join('\n');
}

export function buildClaudeArguments(spec) {
  const effectivePermission = effectivePermissionMode(spec.capabilityProfile, spec.permissionMode);
  const argumentsList = ['-p'];
  if (spec.useBare) argumentsList.push('--bare');

  argumentsList.push(
    '--model', spec.model,
    '--effort', spec.effort,
    '--output-format', internalOutputFormat(spec.outputFormat),
    '--permission-mode', effectivePermission,
    '--append-system-prompt', buildSystemPrompt(spec.capabilityProfile),
  );

  const disallowedTools = disallowedToolsForProfile(spec.capabilityProfile);
  if (disallowedTools) argumentsList.push('--disallowedTools', disallowedTools);

  if (spec.includePartialMessages && internalOutputFormat(spec.outputFormat) === 'stream-json') {
    argumentsList.push('--include-partial-messages');
  }

  if (spec.includeHookEvents && internalOutputFormat(spec.outputFormat) === 'stream-json') {
    argumentsList.push('--include-hook-events');
  }

  if (spec.verbose) {
    argumentsList.push('--verbose');
  }

  if (spec.capabilityProfile !== 'ui-audit' && spec.bypassPermissions && effectivePermission !== 'bypassPermissions') {
    argumentsList.push('--dangerously-skip-permissions');
  }

  for (const directory of spec.additionalDirectories) {
    argumentsList.push('--add-dir', directory);
  }

  argumentsList.push('--', buildDelegatePrompt(spec));
  return argumentsList;
}

export function shouldUseNativeRunner(spec) {
  return Boolean(spec.preferNativeRunner && spec.nativeRunnerBin && !['raw', 'trace'].includes(spec.streamVisibility));
}

export function buildNativeRunnerArguments(spec) {
  const effectivePermission = effectivePermissionMode(spec.capabilityProfile, spec.permissionMode);
  const argumentsList = [
    '--workdir', spec.workdir,
    '--capability-profile', spec.capabilityProfile,
    '--permission-mode', effectivePermission,
    '--output-format', 'text',
    '--model', spec.model,
    '--effort', mapEffortForNativeRunner(spec.effort),
    '--claude-bin', spec.claudeBin,
  ];

  if (spec.bypassPermissions && effectivePermission !== 'bypassPermissions') {
    argumentsList.push('--bypass-permissions');
  }

  for (const directory of spec.additionalDirectories) {
    argumentsList.push('--add-dir', directory);
  }

  argumentsList.push(buildDelegatePrompt(spec));
  return argumentsList;
}

export function previewCommand(spec) {
  if (shouldUseNativeRunner(spec)) {
    return {
      executable: spec.nativeRunnerBin,
      workdir: spec.workdir,
      arguments: buildNativeRunnerArguments(spec),
      runtime: 'native-runner',
    };
  }

  return {
    executable: spec.claudeBin,
    workdir: spec.workdir,
    arguments: buildClaudeArguments(spec),
    runtime: 'portable-bridge',
  };
}
