#!/usr/bin/env node
/**
 * Hand the scheduled reports the admin queued for this agent to its Telegram chats.
 *
 * Every run: `GET /agent/report-deliveries` -> download each file from its `download_url` -> `sendDocument` to every chat of
 * `CLOUDISP_REPORT_CHAT_IDS` -> `POST /agent/report-deliveries/{id}/ack` once EVERY chat got it. A failure is logged and the
 * delivery stays queued, so the next run (the systemd timer, every 5 minutes) retries it; with a state file
 * (`CLOUDISP_REPORT_STATE`) the retry skips the chats that already received it. Exit 1 only when the configuration is invalid.
 *
 * Environment: CLOUDISP_API_BASE, CLOUDISP_API_KEY (scope `reports:read`), CLOUDISP_TELEGRAM_BOT_TOKEN, CLOUDISP_REPORT_CHAT_IDS
 * (comma list of chat ids). Neither secret is ever logged; the API key is never sent to the file host or to Telegram.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const API_PREFIX = '/api/v1/public';
const REQUEST_TIMEOUT_MS = 30000;
const UPLOAD_TIMEOUT_MS = 120000;
const MIME_TYPES = { pdf: 'application/pdf', csv: 'text/csv' };

/** The configuration cannot work: the only failure that makes the script exit 1. */
export class ConfigError extends Error {}

/**
 * @param {Record<string, string|undefined>} env Environment bag.
 * @return {{ base: string, key: string, token: string, chats: string[], statePath: string }} Validated configuration.
 * @throws {ConfigError} When something is missing or malformed (the message never carries a secret).
 */
export function readConfig(env) {
    const base = (env.CLOUDISP_API_BASE || '').trim().replace(/\/+$/, '');
    const key = (env.CLOUDISP_API_KEY || '').trim();
    const token = (env.CLOUDISP_TELEGRAM_BOT_TOKEN || '').trim();
    const chats = (env.CLOUDISP_REPORT_CHAT_IDS || '').split(',').map((id) => id.trim()).filter((id) => id !== '');
    let url = null;

    try {
        url = new URL(base);
    } catch {
        // reported below
    }

    if (url === null || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new ConfigError('CLOUDISP_API_BASE must be an https URL (http only for localhost).');
    }

    if (key === '' || key.startsWith('op://')) {
        throw new ConfigError('CLOUDISP_API_KEY is missing (or an unresolved op:// reference).');
    }

    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
        throw new ConfigError('CLOUDISP_TELEGRAM_BOT_TOKEN is missing or malformed (or an unresolved op:// reference).');
    }

    if (chats.length === 0 || !chats.every((id) => /^-?\d{3,20}$/.test(id))) {
        throw new ConfigError('CLOUDISP_REPORT_CHAT_IDS must be a comma list of numeric Telegram chat ids.');
    }

    return { base, key, token, chats, statePath: (env.CLOUDISP_REPORT_STATE || '').trim() };
}

/**
 * @param {string} date `YYYY-MM-DD`.
 * @return {string} `DD/MM/YYYY`, or the input when it is not a date.
 */
function displayDate(date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date ?? '');

    return match === null ? String(date ?? '') : `${match[3]}/${match[2]}/${match[1]}`;
}

/**
 * @param {object} delivery One entry of `GET /agent/report-deliveries`.
 * @return {{ caption: string, filename: string, mime: string }} What Telegram shows and names the file.
 */
export function documentMeta(delivery) {
    const format = Object.hasOwn(MIME_TYPES, delivery.format) ? delivery.format : 'pdf';
    const period = delivery.period_from && delivery.period_to ? ` · ${displayDate(delivery.period_from)}–${displayDate(delivery.period_to)}` : '';
    const stem = `${delivery.report_key ?? 'informe'}-${delivery.period_to ?? delivery.id}`.replace(/[^A-Za-z0-9_-]+/g, '_');

    return { caption: `📊 ${delivery.report_title ?? delivery.report_key ?? 'Informe'}${period}`.slice(0, 1024), filename: `${stem}.${format}`, mime: MIME_TYPES[format] };
}

/**
 * @param {string} path State file, or '' for none.
 * @return {Record<string, string[]>} Chats already served, by delivery id.
 */
function loadLedger(path) {
    if (path === '') {
        return {};
    }

    try {
        const ledger = JSON.parse(readFileSync(path, 'utf8'));

        return ledger !== null && typeof ledger === 'object' && !Array.isArray(ledger) ? ledger : {};
    } catch {
        return {};
    }
}

/**
 * @param {string} path State file, or '' for none.
 * @param {Record<string, string[]>} ledger Chats already served, by delivery id.
 * @return {void}
 */
function saveLedger(path, ledger) {
    if (path === '') {
        return;
    }

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(`${path}.tmp`, JSON.stringify(ledger), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    chmodSync(path, 0o600);
}

/**
 * Deliver what is queued.
 *
 * @param {{ env?: Record<string, string|undefined>, fetchImpl?: Function, log?: Function }} [options] Environment, `fetch` and logger (stderr).
 * @return {Promise<{ delivered: number, pending: number }>} Deliveries acked, and left for the next run.
 * @throws {ConfigError} When the configuration is invalid.
 */
export async function deliverReports({ env = process.env, fetchImpl = globalThis.fetch, log = (line) => console.error(line) } = {}) {
    const config = readConfig(env);
    const auth = { Authorization: `Bearer ${config.key}`, Accept: 'application/json' };
    const api = (method, path) => fetchImpl(`${config.base}${API_PREFIX}${path}`, { method, headers: auth, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    // Only the error class is logged: a fetch error message may carry the URL, and the Telegram URL holds the bot token.
    const why = (error) => `${error?.name ?? 'Error'}${error?.cause?.code ? ` ${error.cause.code}` : ''}`;

    let listing;

    try {
        const response = await api('GET', '/agent/report-deliveries');

        if (!response.ok) {
            log(`report-delivery: listing the deliveries answered HTTP ${response.status}; nothing sent.`);

            return { delivered: 0, pending: 0 };
        }

        listing = await response.json();
    } catch (error) {
        log(`report-delivery: listing the deliveries failed (${why(error)}); nothing sent.`);

        return { delivered: 0, pending: 0 };
    }

    const deliveries = Array.isArray(listing?.data) ? listing.data : (Array.isArray(listing?.data?.deliveries) ? listing.data.deliveries : []);
    const ledger = loadLedger(config.statePath);
    const kept = {};
    let delivered = 0;
    let pending = 0;

    for (const delivery of deliveries) {
        const id = String(delivery.id);
        const served = Array.isArray(ledger[id]) ? ledger[id].filter((chat) => config.chats.includes(chat)) : [];
        const missing = config.chats.filter((chat) => !served.includes(chat));

        if (missing.length > 0) {
            let bytes;

            try {
                // Object storage gets no credentials; only the API origin receives the bearer key.
                const downloadUrl = new URL(delivery.download_url);
                const sameOrigin = downloadUrl.origin === new URL(config.base).origin;
                const file = await fetchImpl(delivery.download_url, { headers: sameOrigin ? auth : undefined, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

                if (!file.ok) {
                    throw new Error(`HTTP ${file.status}`);
                }

                bytes = new Uint8Array(await file.arrayBuffer());
            } catch (error) {
                log(`report-delivery: delivery ${id}: downloading the file failed (${why(error)}); it stays queued.`);
                kept[id] = served;
                pending += 1;
                continue;
            }

            const { caption, filename, mime } = documentMeta(delivery);

            for (const chat of missing) {
                try {
                    const form = new FormData();

                    form.set('chat_id', chat);
                    form.set('caption', caption);
                    form.set('document', new Blob([bytes], { type: mime }), filename);

                    const sent = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
                    const body = await sent.json().catch(() => null);

                    if (sent.ok && body?.ok === true) {
                        served.push(chat);
                    } else {
                        log(`report-delivery: delivery ${id}: Telegram refused chat ${chat} (HTTP ${sent.status}${typeof body?.description === 'string' ? `: ${body.description}` : ''}).`);
                    }
                } catch (error) {
                    log(`report-delivery: delivery ${id}: sending to chat ${chat} failed (${why(error)}).`);
                }
            }
        }

        if (!config.chats.every((chat) => served.includes(chat))) {
            kept[id] = served;
            pending += 1;
            continue;
        }

        try {
            const ack = await api('POST', `/agent/report-deliveries/${encodeURIComponent(id)}/ack`);

            if (!ack.ok) {
                throw new Error(`HTTP ${ack.status}`);
            }

            delivered += 1;
        } catch (error) {
            // Sent everywhere: the next run only asks for the ack again.
            log(`report-delivery: delivery ${id}: the ack failed (${why(error)}); it will be retried.`);
            kept[id] = served;
            pending += 1;
        }
    }

    saveLedger(config.statePath, kept);

    return { delivered, pending };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const { delivered, pending } = await deliverReports();

        console.log(`report-delivery: delivered=${delivered} pending=${pending}`);
    } catch (error) {
        if (error instanceof ConfigError) {
            console.error(`report-delivery: ${error.message}`);
            process.exit(1);
        }

        console.error(`report-delivery: ${error?.name ?? 'Error'}; will retry on the next run.`);
    }
}
