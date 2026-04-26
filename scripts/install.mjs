#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const homeDir = os.homedir();
const agentsPluginsDir = path.join(homeDir, '.agents', 'plugins');
const marketplacePath = path.join(agentsPluginsDir, 'marketplace.json');
const codexHome = path.join(homeDir, '.codex');
const pluginInstallDir = path.join(codexHome, 'plugins', 'claude-in-codex');
const legacyAgentsInstallDir = path.join(agentsPluginsDir, 'claude-in-codex');
const configPath = path.join(codexHome, 'config.toml');
const cacheDir = path.join(codexHome, 'plugins', 'cache', 'xt0n1', 'claude-in-codex', 'local');
const nativeRunnerPath = path.join(codexHome, 'tools', 'claude', 'target', 'release', process.platform === 'win32' ? 'claude.exe' : 'claude');

const INCLUDE = new Set(['.codex-plugin', 'assets', 'examples', 'native', 'scripts', 'skills', 'README.md', 'LICENSE', 'PRIVACY.md', 'TERMS.md', 'package.json']);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    ensureDir(dest);
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function rimraf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function updateMarketplace() {
  ensureDir(agentsPluginsDir);
  let marketplace = {
    name: 'xt0n1',
    interface: { displayName: 'XT0N1' },
    plugins: [],
  };
  if (fs.existsSync(marketplacePath)) {
    marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
    marketplace.plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  }

  const entry = {
    name: 'claude-in-codex',
    source: {
      source: 'local',
      path: './.codex/plugins/claude-in-codex',
    },
    policy: {
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    },
    category: 'Coding',
  };

  const idx = marketplace.plugins.findIndex((plugin) => plugin?.name === 'claude-in-codex');
  if (idx >= 0) marketplace.plugins[idx] = entry;
  else marketplace.plugins.push(entry);
  fs.writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n');
}

function updateConfig() {
  ensureDir(codexHome);
  let config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const block = '[plugins."claude-in-codex@xt0n1"]\nenabled = true\n';
  if (!config.includes(block)) {
    if (config && !config.endsWith('\n')) config += '\n';
    config += (config ? '\n' : '') + block;
    fs.writeFileSync(configPath, config);
  }
}

function installNativeRunner() {
  const source = path.join(repoRoot, 'native', 'claude.go');
  if (!fs.existsSync(source)) return { installed: false, reason: 'native source not found' };

  const check = spawnSync('go', ['version'], { encoding: 'utf8', shell: false, windowsHide: true });
  if (check.status !== 0) return { installed: false, reason: 'go not found on PATH' };

  ensureDir(path.dirname(nativeRunnerPath));
  const build = spawnSync('go', ['build', '-o', nativeRunnerPath, source], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });

  if (build.status !== 0) {
    return {
      installed: false,
      reason: 'go build failed',
      stderr: build.stderr.trim(),
    };
  }

  return { installed: true, path: nativeRunnerPath };
}

function main() {
  rimraf(pluginInstallDir);
  rimraf(legacyAgentsInstallDir);
  ensureDir(pluginInstallDir);
  for (const entry of fs.readdirSync(repoRoot)) {
    if (!INCLUDE.has(entry)) continue;
    copyRecursive(path.join(repoRoot, entry), path.join(pluginInstallDir, entry));
  }

  updateMarketplace();
  updateConfig();
  const nativeRunner = installNativeRunner();

  rimraf(cacheDir);
  copyRecursive(pluginInstallDir, cacheDir);

  console.log(JSON.stringify({
    installedTo: pluginInstallDir,
    marketplace: marketplacePath,
    config: configPath,
    cache: cacheDir,
    nativeRunner,
    nextStep: 'Restart Codex to refresh the plugin registry.',
  }, null, 2));
}

main();
