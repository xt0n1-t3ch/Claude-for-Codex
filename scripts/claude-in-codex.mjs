#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { previewCommand, resolveInvocationSpec } from './lib/command.mjs';
import { runClaudeInCodex, runDoctor } from './lib/runner.mjs';

function parseArgs(argv) {
  const parsed = { command: 'run', specFile: '', showCommand: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case 'doctor': parsed.command = 'doctor'; break;
      case '--spec-file': parsed.specFile = argv[index + 1] ?? ''; index += 1; break;
      case '--show-command': parsed.showCommand = true; break;
      case '--help':
      case '-h': parsed.help = true; break;
      default: break;
    }
  }
  return parsed;
}

function printHelp() {
  process.stdout.write([
    'claude-in-codex.mjs',
    '',
    'Usage:',
    '  node claude-in-codex.mjs --spec-file <path.json> [--show-command]',
    '  node claude-in-codex.mjs doctor',
    '',
  ].join('\n'));
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) { printHelp(); return; }
  if (parsed.command === 'doctor') process.exit(await runDoctor());
  if (!parsed.specFile) throw new Error('Missing required --spec-file argument.');

  const specPath = path.resolve(parsed.specFile);
  const rawSpec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const spec = resolveInvocationSpec({ ...rawSpec, showCommand: parsed.showCommand });

  if (parsed.showCommand) {
    process.stdout.write(`${JSON.stringify(previewCommand(spec), null, 2)}\n`);
    return;
  }

  await runClaudeInCodex(spec);
}

main().catch((error) => {
  process.stderr.write(`[claude-in-codex][fatal] ${error?.stack ?? error}\n`);
  process.exit(1);
});
