import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDelegatePrompt,
  buildClaudeArguments,
  buildNativeRunnerArguments,
  mapEffortForNativeRunner,
  resolveInvocationSpec,
  shouldUseNativeRunner,
} from '../lib/command.mjs';

test('resolveInvocationSpec applies profile aliases and defaults', () => {
  const spec = resolveInvocationSpec({
    prompt: 'Polish the dashboard shell.',
    profile: 'frontend',
    workdir: 'C:/repo',
  });

  assert.equal(spec.capabilityProfile, 'design');
  assert.equal(spec.model, 'claude-opus-4-6[1m]');
  assert.equal(spec.effort, 'high');
  assert.equal(spec.permissionMode, 'acceptEdits');
  assert.equal(spec.outputFormat, 'stream-json');
  assert.equal(spec.streamVisibility, 'events');
  assert.equal(spec.includeHookEvents, false);
  assert.equal(spec.workdir, 'C:/repo');
  assert.equal(spec.useBare, false);
  assert.equal(spec.preferNativeRunner, true);
});

test('buildDelegatePrompt folds task context and fallback metadata into the task payload', () => {
  const prompt = buildDelegatePrompt({
    prompt: 'Investigate the auth regression.',
    taskContext: '<task_context>\nphase: challenge\nscope: auth only\n</task_context>',
    fallbackOrigin: 'codex',
    fallbackReason: 'Need a second-opinion pass.',
  });

  assert.match(prompt, /Task context:/);
  assert.match(prompt, /phase: challenge/);
  assert.match(prompt, /Fallback handoff context:/);
  assert.match(prompt, /origin: codex/);
  assert.match(prompt, /reason: Need a second-opinion pass\./);
  assert.match(prompt, /Task:\nInvestigate the auth regression\./);
});

test('buildClaudeArguments emits a non-interactive Claude Code invocation with profile prompt', () => {
  const spec = resolveInvocationSpec({
    prompt: 'Review the auth diff for regressions.',
    profile: 'review',
    workdir: 'C:/repo',
    additionalDirectories: ['C:/repo/shared'],
  });

  const args = buildClaudeArguments(spec);

  assert.deepEqual(args.slice(0, 9), [
    '-p',
    '--model',
    'claude-opus-4-6[1m]',
    '--effort',
    'high',
    '--output-format',
    'stream-json',
    '--permission-mode',
    'dontAsk',
  ]);
  assert.ok(!args.includes('--bare'));
  assert.ok(args.includes('--append-system-prompt'));
  assert.ok(args.includes('--add-dir'));
  assert.ok(args.includes('C:/repo/shared'));
  assert.ok(args.includes('--disallowedTools'));
  assert.ok(args.includes('Write,Edit,MultiEdit,NotebookEdit'));
  assert.equal(args.at(-2), '--');
  assert.match(args.at(-1), /Review the auth diff for regressions\./);
});

test('buildClaudeArguments includes hook events when raw streaming is requested', () => {
  const spec = resolveInvocationSpec({
    prompt: 'Reply with exactly: OK',
    workdir: 'C:/repo',
    profile: 'general',
    streamVisibility: 'raw',
  });

  const args = buildClaudeArguments(spec);

  assert.ok(args.includes('--include-hook-events'));
});

test('buildClaudeArguments includes verbose flag when explicitly requested', () => {
  const spec = resolveInvocationSpec({
    prompt: 'Reply with exactly: OK',
    workdir: 'C:/repo',
    profile: 'general',
    verbose: true,
  });

  const args = buildClaudeArguments(spec);

  assert.ok(args.includes('--verbose'));
});

test('native runner is preferred for friendly realtime modes when available', () => {
  const spec = resolveInvocationSpec({
    prompt: 'Reply with exactly: OK',
    workdir: 'C:/repo',
    profile: 'general',
    streamVisibility: 'events',
    nativeRunnerBin: 'C:/Users/test/.codex/tools/claude/target/release/claude.exe',
  });

  assert.equal(shouldUseNativeRunner(spec), true);
});

test('native runner is not used for raw or trace modes', () => {
  const raw = resolveInvocationSpec({
    prompt: 'Reply with exactly: OK',
    workdir: 'C:/repo',
    profile: 'general',
    streamVisibility: 'raw',
    nativeRunnerBin: 'C:/runner/claude.exe',
  });
  const trace = resolveInvocationSpec({
    prompt: 'Reply with exactly: OK',
    workdir: 'C:/repo',
    profile: 'general',
    streamVisibility: 'trace',
    nativeRunnerBin: 'C:/runner/claude.exe',
  });

  assert.equal(shouldUseNativeRunner(raw), false);
  assert.equal(shouldUseNativeRunner(trace), false);
});

test('buildNativeRunnerArguments maps xhigh to max and forwards the delegated prompt', () => {
  const spec = resolveInvocationSpec({
    prompt: 'Investigate the flaky test.',
    workdir: 'C:/repo',
    profile: 'general',
    effort: 'xhigh',
    nativeRunnerBin: 'C:/runner/claude.exe',
  });

  const args = buildNativeRunnerArguments(spec);

  assert.deepEqual(args.slice(0, 12), [
    '--workdir',
    'C:/repo',
    '--capability-profile',
    'general',
    '--permission-mode',
    'acceptEdits',
    '--output-format',
    'text',
    '--model',
    'claude-opus-4-6[1m]',
    '--effort',
    'max',
  ]);
  assert.equal(args.at(-1), 'Investigate the flaky test.');
});

test('resolveInvocationSpec accepts trace as a structured debug renderer mode', () => {
  const spec = resolveInvocationSpec({
    prompt: 'Reply with exactly: OK',
    workdir: 'C:/repo',
    profile: 'general',
    streamVisibility: 'trace',
  });

  assert.equal(spec.streamVisibility, 'trace');
});

test('resolveInvocationSpec rejects prompts that are blank after trimming', () => {
  assert.throws(
    () => resolveInvocationSpec({ prompt: '   ', workdir: 'C:/repo' }),
    /prompt/i,
  );
});

test('mapEffortForNativeRunner keeps standard values and upgrades xhigh to max', () => {
  assert.equal(mapEffortForNativeRunner('low'), 'low');
  assert.equal(mapEffortForNativeRunner('medium'), 'medium');
  assert.equal(mapEffortForNativeRunner('high'), 'high');
  assert.equal(mapEffortForNativeRunner('xhigh'), 'max');
});
