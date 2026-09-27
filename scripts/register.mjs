#!/usr/bin/env node
/**
 * Register cloudisp-mcp in every supported agent found on this machine.
 *
 * Usage: node scripts/register.mjs <repoDir> <cfgDir> <env...>
 *
 * Links the skills and registers one stdio server per environment (prod ->
 * `cloudisp`, otherwise `cloudisp-<env>`) in Claude Code, Codex, omp, pi and
 * opencode. JSON configs are merged key by key and written atomically; a config
 * that does not parse as strict JSON is never touched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [repoDir, , ...envs] = process.argv.slice(2);
if (!repoDir || envs.length === 0) {
    console.error('uso: register.mjs <repoDir> <cfgDir> <env...>');
    process.exit(1);
}

const home = os.homedir();
const launcher = path.join(repoDir, 'bin', 'cloudisp-mcp');
const serverName = (env) => (env === 'prod' ? 'cloudisp' : `cloudisp-${env}`);
const summary = [];

/**
 * Whether a CLI is on PATH.
 *
 * @param {string} bin Command name.
 * @return {boolean}
 */
function hasCli(bin) {
    return spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;
}

/**
 * Link every skill directory into one skills root.
 *
 * @param {string} root Target skills directory.
 */
function linkSkills(root) {
    fs.mkdirSync(root, { recursive: true });
    for (const name of fs.readdirSync(path.join(repoDir, 'skills'))) {
        const source = path.join(repoDir, 'skills', name);
        const target = path.join(root, name);
        const stat = fs.lstatSync(target, { throwIfNoEntry: false });
        if (stat && !stat.isSymbolicLink()) {
            console.warn(`skills: ${target} existe y no es un symlink, omitido`);
            continue;
        }
        if (stat) fs.unlinkSync(target);
        fs.symlinkSync(source, target);
    }
}

/**
 * Merge entries into a JSON config file atomically.
 *
 * @param {string} file Config path.
 * @param {object} initial Content used when the file does not exist.
 * @param {function(object): void} mutate In-place mutation.
 * @return {boolean} False when the existing file is not strict JSON (left untouched).
 */
function mergeJson(file, initial, mutate) {
    let data = initial;
    if (fs.existsSync(file)) {
        try {
            data = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            return false;
        }
    }
    mutate(data);
    const tmp = `${file}.cloudisp-${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return true;
}

// Skills
const skillRoots = [path.join(home, '.agents', 'skills')];
if (fs.existsSync(path.join(home, '.claude'))) skillRoots.push(path.join(home, '.claude', 'skills'));
if (fs.existsSync(path.join(home, '.omp', 'agent'))) skillRoots.push(path.join(home, '.omp', 'agent', 'skills'));
skillRoots.forEach(linkSkills);
const codexSkills = path.join(home, '.codex', 'skills');
if (fs.existsSync(codexSkills)) {
    for (const name of fs.readdirSync(codexSkills)) {
        const target = path.join(codexSkills, name);
        if (name.startsWith('cloudisp-') && fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
    }
}
summary.push(`skills: enlazadas en ${skillRoots.join(', ')}`);

// Claude Code and Codex own their config files; use their CLIs.
for (const [agent, removeArgs, addArgs] of [
    ['claude', (n) => ['mcp', 'remove', '--scope', 'user', n], (n) => ['mcp', 'add', '--scope', 'user', n, '--']],
    ['codex', (n) => ['mcp', 'remove', n], (n) => ['mcp', 'add', n, '--']],
]) {
    if (!hasCli(agent)) {
        summary.push(`${agent}: no instalado, omitido`);
        continue;
    }
    for (const env of envs) {
        spawnSync(agent, removeArgs(serverName(env)), { stdio: 'ignore' });
        const added = spawnSync(agent, [...addArgs(serverName(env)), launcher, env], { stdio: 'ignore' });
        summary.push(`${agent}: ${serverName(env)} ${added.status === 0 ? 'registrado' : 'falló el registro'}`);
    }
}

// omp
if (fs.existsSync(path.join(home, '.omp', 'agent'))) {
    const ok = mergeJson(path.join(home, '.omp', 'agent', 'mcp.json'), {}, (data) => {
        data.mcpServers ??= {};
        for (const env of envs) {
            data.mcpServers[serverName(env)] = { type: 'stdio', command: launcher, args: [env], enabled: true, timeout: 60000 };
        }
    });
    summary.push(`omp: ${ok ? 'registrado' : 'manual (mcp.json no es JSON válido)'}`);
} else {
    summary.push('omp: no instalado, omitido');
}

// pi (needs the pi-mcp-adapter extension)
if (fs.existsSync(path.join(home, '.pi', 'agent'))) {
    const ok = mergeJson(path.join(home, '.pi', 'agent', 'mcp.json'), {}, (data) => {
        data.mcpServers ??= {};
        for (const env of envs) data.mcpServers[serverName(env)] = { command: launcher, args: [env] };
    });
    summary.push(`pi: ${ok ? 'registrado' : 'manual (mcp.json no es JSON válido)'}`);
    if (!fs.existsSync(path.join(home, '.pi', 'agent', 'npm', 'node_modules', 'pi-mcp-adapter'))) {
        summary.push('pi: instalá el adaptador MCP con "pi install npm:pi-mcp-adapter"');
    }
} else {
    summary.push('pi: no instalado, omitido');
}

// opencode
const opencodeDir = path.join(home, '.config', 'opencode');
if (fs.existsSync(opencodeDir)) {
    const entries = Object.fromEntries(envs.map((env) => [serverName(env), { type: 'local', command: [launcher, env], enabled: true, timeout: 60000 }]));
    const ok = mergeJson(path.join(opencodeDir, 'opencode.json'), { $schema: 'https://opencode.ai/config.json' }, (data) => {
        data.mcp = { ...(data.mcp ?? {}), ...entries };
    });
    if (ok) {
        summary.push('opencode: registrado');
    } else {
        summary.push('opencode: manual — opencode.json tiene comentarios; agregá este bloque a mano:');
        summary.push(JSON.stringify({ mcp: entries }, null, 2));
    }
} else {
    summary.push('opencode: no instalado, omitido');
}

console.log(summary.map((line) => `cloudisp-mcp: ${line}`).join('\n'));
