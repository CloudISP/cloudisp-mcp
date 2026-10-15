/**
 * Local files the MCP hands to the agent (report exports, HTML reports).
 *
 * The directory is `CLOUDISP_ARTIFACT_DIR` (default `~/.cache/cloudisp-artifacts`), created with mode
 * 700; files older than 24 h are deleted before every new write.
 */

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * @param {Record<string, string|undefined>} env Environment bag.
 * @return {string} Absolute artifact directory.
 */
export function artifactDir(env) {
    const configured = (env?.CLOUDISP_ARTIFACT_DIR || '').trim();

    return configured === '' ? join(homedir(), '.cache', 'cloudisp-artifacts') : configured;
}

/**
 * Write one artifact: create the directory (700), sweep expired files, write the file (600).
 *
 * @param {Record<string, string|undefined>} env Environment bag.
 * @param {string} name File name (no directory part).
 * @param {Buffer|string} data File content.
 * @param {number} [now] Epoch milliseconds, for the age sweep.
 * @return {{ path: string, bytes: number }} Absolute path and size.
 */
export function saveArtifact(env, name, data, now = Date.now()) {
    const dir = artifactDir(env);

    mkdirSync(dir, { recursive: true, mode: 0o700 });

    for (const entry of readdirSync(dir)) {
        const file = join(dir, entry);

        try {
            const stat = statSync(file);

            if (stat.isFile() && now - stat.mtimeMs > ARTIFACT_MAX_AGE_MS) {
                unlinkSync(file);
            }
        } catch {
            // Raced with another sweep or a deletion: nothing to clean.
        }
    }

    const path = join(dir, name);

    writeFileSync(path, data, { mode: 0o600 });

    return { path, bytes: Buffer.byteLength(data) };
}

/**
 * @param {number} [now] Epoch milliseconds.
 * @return {string} `yyyymmddhhmmss` in Argentina (Salta) time, for file names.
 */
export function fileStamp(now = Date.now()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Argentina/Salta', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(now)).map((part) => [part.type, part.value]));

    return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
}
