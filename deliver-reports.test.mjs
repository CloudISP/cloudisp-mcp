/**
 * Tests for `scripts/deliver-reports.mjs` (the scheduled-report delivery to the agent's Telegram chats) and its wrapper.
 *
 * `node --test deliver-reports.test.mjs` — no dependencies beyond Node 18+.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ConfigError, deliverReports, documentMeta, readConfig } from './scripts/deliver-reports.mjs';

const API_BASE = 'https://admin.cloudisp.test';
const API_KEY = 'secret-api-key';
const BOT_TOKEN = '123456789:AAEhBP0av28-secret_token';
const FILE_HOST = 'https://files.cloudisp.test';
const PDF = new TextEncoder().encode('%PDF-1.7 informe');

const ENV = {
    CLOUDISP_API_BASE: API_BASE,
    CLOUDISP_API_KEY: API_KEY,
    CLOUDISP_TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    CLOUDISP_REPORT_CHAT_IDS: '941533777, -1001234567890',
};

const DELIVERY = {
    id: 7,
    report_key: 'ventas',
    report_title: 'Reporte de ventas',
    schedule_name: 'Ventas diario',
    period_from: '2026-11-01',
    period_to: '2026-11-19',
    format: 'pdf',
    created_at: '2026-11-20T08:05:00-03:00',
    download_url: `${FILE_HOST}/ventas-7.pdf?signature=abc`,
};

/**
 * A network double for the API, the file host and Telegram; it records every request.
 *
 * @param {{ deliveries?: object[], refuse?: string[], file?: number, ack?: number, listing?: number }} [options] `refuse` lists chat ids Telegram answers 403 to.
 * @return {{ fetchImpl: Function, calls: object[], sent: object[], acks: string[], logs: string[], log: Function }}
 */
function network({ deliveries = [DELIVERY], refuse = [], file = 200, ack = 200, listing = 200 } = {}) {
    const calls = [];
    const sent = [];
    const acks = [];
    const logs = [];
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    const fetchImpl = async (url, init = {}) => {
        const target = String(url);
        const headers = init.headers ?? {};

        calls.push({ method: init.method ?? 'GET', url: target, headers });

        if (target === `${API_BASE}/api/v1/public/agent/report-deliveries`) {
            return json({ success: true, data: deliveries }, listing);
        }

        if (target.startsWith(`${API_BASE}/api/v1/public/agent/report-deliveries/`) && target.endsWith('/ack')) {
            acks.push(target.split('/').at(-2));

            return json({ success: true }, ack);
        }

        if (target.startsWith(FILE_HOST)) {
            return new Response(file === 200 ? PDF : 'denied', { status: file });
        }

        if (target === `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`) {
            const chat = init.body.get('chat_id');
            const document = init.body.get('document');

            sent.push({ chat, caption: init.body.get('caption'), filename: document.name, type: document.type, bytes: new Uint8Array(await document.arrayBuffer()) });

            return refuse.includes(chat)
                ? json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 403)
                : json({ ok: true, result: { message_id: 1 } });
        }

        throw new Error(`Unexpected request: ${target}`);
    };

    return { fetchImpl, calls, sent, acks, logs, log: (line) => logs.push(line) };
}

test('one delivery to two chats is two documents and one ack, and no credential reaches the file host or Telegram', async () => {
    const net = network();
    const result = await deliverReports({ env: ENV, fetchImpl: net.fetchImpl, log: net.log });

    assert.deepEqual(result, { delivered: 1, pending: 0 });
    assert.deepEqual(net.sent.map((entry) => entry.chat), ['941533777', '-1001234567890']);

    for (const entry of net.sent) {
        assert.equal(entry.caption, '📊 Reporte de ventas · 01/11/2026–19/11/2026');
        assert.equal(entry.filename, 'ventas-2026-11-19.pdf');
        assert.equal(entry.type, 'application/pdf');
        assert.deepEqual(entry.bytes, PDF);
    }

    assert.deepEqual(net.acks, ['7']);
    assert.deepEqual(net.logs, []);

    const [list, download, , , ack] = net.calls;

    assert.equal(list.headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(ack.method, 'POST');
    assert.equal(ack.headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(download.url, DELIVERY.download_url);
    assert.equal(download.headers.Authorization, undefined, 'the signed file URL gets no bearer key');
    assert.equal(net.calls.filter((call) => call.url.includes('telegram')).every((call) => call.headers.Authorization === undefined), true);
});

test('a same-origin download gets the API Authorization header', async () => {
    const delivery = { ...DELIVERY, download_url: `${API_BASE}/api/v1/public/agent/report-deliveries/7/file` };
    const net = network({ deliveries: [delivery] });

    const fetchWithSameOriginFile = async (url, init = {}) => {
        if (String(url) === delivery.download_url) {
            net.calls.push({ method: init.method ?? 'GET', url: String(url), headers: init.headers ?? {} });

            return new Response(PDF);
        }

        return net.fetchImpl(url, init);
    };

    assert.deepEqual(await deliverReports({ env: ENV, fetchImpl: fetchWithSameOriginFile, log: net.log }), { delivered: 1, pending: 0 });
    const download = net.calls.find((call) => call.url === delivery.download_url);

    assert.equal(download.headers.Authorization, `Bearer ${API_KEY}`);
});



test('a foreign-origin download never gets the API Authorization header', async () => {
    const net = network();

    assert.deepEqual(await deliverReports({ env: ENV, fetchImpl: net.fetchImpl, log: net.log }), { delivered: 1, pending: 0 });
    const download = net.calls.find((call) => call.url === DELIVERY.download_url);

    assert.equal(download.headers.Authorization, undefined);
});

test('a chat that refuses keeps the delivery queued with no ack, and the retry only resends to that chat', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudisp-delivery-'));
    const env = { ...ENV, CLOUDISP_REPORT_STATE: path.join(dir, 'state', 'deliveries.json') };

    const first = network({ refuse: ['-1001234567890'] });

    assert.deepEqual(await deliverReports({ env, fetchImpl: first.fetchImpl, log: first.log }), { delivered: 0, pending: 1 });
    assert.deepEqual(first.sent.map((entry) => entry.chat), ['941533777', '-1001234567890']);
    assert.deepEqual(first.acks, []);
    assert.equal(first.logs.length, 1);
    assert.match(first.logs[0], /Telegram refused chat -1001234567890 \(HTTP 403: Forbidden: bot was blocked by the user\)/);
    assert.equal(fs.statSync(env.CLOUDISP_REPORT_STATE).mode & 0o777, 0o600);

    const retry = network();

    assert.deepEqual(await deliverReports({ env, fetchImpl: retry.fetchImpl, log: retry.log }), { delivered: 1, pending: 0 });
    assert.deepEqual(retry.sent.map((entry) => entry.chat), ['-1001234567890'], 'the chat that already has it is not served twice');
    assert.deepEqual(retry.acks, ['7']);
    assert.deepEqual(JSON.parse(fs.readFileSync(env.CLOUDISP_REPORT_STATE, 'utf8')), {}, 'an acked delivery leaves the state file');

    const none = network({ deliveries: [] });

    assert.deepEqual(await deliverReports({ env, fetchImpl: none.fetchImpl, log: none.log }), { delivered: 0, pending: 0 });
    assert.equal(none.calls.length, 1, 'with nothing queued only the listing is asked');
});

test('a failed ack asks again next time without sending the document again', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudisp-delivery-'));
    const env = { ...ENV, CLOUDISP_REPORT_STATE: path.join(dir, 'deliveries.json') };
    const failing = network({ ack: 500 });

    assert.deepEqual(await deliverReports({ env, fetchImpl: failing.fetchImpl, log: failing.log }), { delivered: 0, pending: 1 });
    assert.equal(failing.sent.length, 2);
    assert.match(failing.logs[0], /the ack failed/);

    const retry = network();

    assert.deepEqual(await deliverReports({ env, fetchImpl: retry.fetchImpl, log: retry.log }), { delivered: 1, pending: 0 });
    assert.deepEqual(retry.sent, []);
    assert.deepEqual(retry.acks, ['7']);
    assert.equal(retry.calls.some((call) => call.url.startsWith(FILE_HOST)), false, 'nothing to send, nothing to download');
});

test('a failed listing or download sends nothing, acks nothing and does not throw', async () => {
    const listing = network({ listing: 503 });

    assert.deepEqual(await deliverReports({ env: ENV, fetchImpl: listing.fetchImpl, log: listing.log }), { delivered: 0, pending: 0 });
    assert.match(listing.logs[0], /HTTP 503/);

    const download = network({ file: 403 });

    assert.deepEqual(await deliverReports({ env: ENV, fetchImpl: download.fetchImpl, log: download.log }), { delivered: 0, pending: 1 });
    assert.deepEqual(download.sent, []);
    assert.deepEqual(download.acks, []);

    const logs = [];
    const refused = async () => { throw new TypeError('fetch failed'); };

    assert.deepEqual(await deliverReports({ env: ENV, fetchImpl: refused, log: (line) => logs.push(line) }), { delivered: 0, pending: 0 }, 'a refused connection to the API is logged, not thrown');
    assert.match(logs[0], /listing the deliveries failed \(TypeError\)/);
});

test('a network error never writes its message, which may carry the bot token, to the log', async () => {
    const logs = [];
    const fetchImpl = async (url) => {
        if (String(url).startsWith(API_BASE)) {
            return new Response(JSON.stringify({ success: true, data: [DELIVERY] }));
        }

        if (String(url).startsWith(FILE_HOST)) {
            return new Response(PDF);
        }

        throw new TypeError(`fetch failed ${url}`);
    };

    assert.deepEqual(await deliverReports({ env: ENV, fetchImpl, log: (line) => logs.push(line) }), { delivered: 0, pending: 1 });
    assert.equal(logs.length, 2);
    assert.equal(logs.join('\n').includes(BOT_TOKEN), false);
    assert.equal(logs.join('\n').includes(API_KEY), false);
});

test('the configuration is validated, and its errors never hold a secret', () => {
    assert.deepEqual(readConfig(ENV).chats, ['941533777', '-1001234567890']);

    for (const [name, override] of [
        ['base', { CLOUDISP_API_BASE: 'http://admin.cloudisp.test' }],
        ['no base', { CLOUDISP_API_BASE: '' }],
        ['key', { CLOUDISP_API_KEY: '' }],
        ['key reference', { CLOUDISP_API_KEY: 'op://Vault/item/credential' }],
        ['token', { CLOUDISP_TELEGRAM_BOT_TOKEN: 'not-a-token' }],
        ['token reference', { CLOUDISP_TELEGRAM_BOT_TOKEN: 'op://Vault/bot/credential' }],
        ['no chats', { CLOUDISP_REPORT_CHAT_IDS: ' , ' }],
        ['bad chat', { CLOUDISP_REPORT_CHAT_IDS: '941533777,@canal' }],
    ]) {
        assert.throws(() => readConfig({ ...ENV, ...override }), (error) => error instanceof ConfigError && !error.message.includes(BOT_TOKEN) && !error.message.includes(API_KEY), name);
    }

    assert.equal(readConfig({ ...ENV, CLOUDISP_API_BASE: 'http://127.0.0.1:8080' }).base, 'http://127.0.0.1:8080');
});

test('the caption and the file name come from the delivery, whatever its format or missing fields', () => {
    assert.deepEqual(documentMeta({ ...DELIVERY, format: 'csv' }), { caption: '📊 Reporte de ventas · 01/11/2026–19/11/2026', filename: 'ventas-2026-11-19.csv', mime: 'text/csv' });
    assert.deepEqual(documentMeta({ id: 9, report_key: 'otestado' }), { caption: '📊 otestado', filename: 'otestado-9.pdf', mime: 'application/pdf' });
    assert.equal(documentMeta({ ...DELIVERY, report_key: '../etc/passwd' }).filename, '_etc_passwd-2026-11-19.pdf');
});

// ─── bin/cloudisp-deliver-reports ────────────────────────────────────────────

const WRAPPER = fileURLToPath(new URL('./bin/cloudisp-deliver-reports', import.meta.url));

/**
 * @param {string[]} args Wrapper arguments.
 * @param {string|null} envFile Content of `<slug>.env`, or null for none.
 * @return {{ status: number, stdout: string, stderr: string }}
 */
function runWrapper(args, envFile) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudisp-wrapper-'));
    const cfg = path.join(home, 'cfg');

    fs.mkdirSync(cfg);

    if (envFile !== null) {
        fs.writeFileSync(path.join(cfg, 'acme.env'), envFile, { mode: 0o600 });
    }

    return spawnSync('bash', [WRAPPER, ...args], { env: { PATH: process.env.PATH, HOME: home, CLOUDISP_MCP_CONFIG_DIR: cfg }, encoding: 'utf8', timeout: 60000 });
}

test('the wrapper refuses a bad slug and a missing environment file', () => {
    assert.equal(runWrapper([], null).status, 1);
    assert.match(runWrapper(['Bad_Slug'], null).stderr, /usage/);

    const missing = runWrapper(['acme'], null);

    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /missing .*acme\.env/);
});

test('the wrapper loads the environment file: an invalid configuration exits 1, an unreachable API exits 0 and is only logged', () => {
    const invalid = runWrapper(['acme'], `CLOUDISP_API_BASE=${API_BASE}\nCLOUDISP_API_KEY=${API_KEY}\nCLOUDISP_TELEGRAM_BOT_TOKEN=${BOT_TOKEN}\nCLOUDISP_REPORT_CHAT_IDS=\n`);

    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /CLOUDISP_REPORT_CHAT_IDS must be a comma list/);
    assert.equal((invalid.stdout + invalid.stderr).includes(BOT_TOKEN), false);

    const unreachable = runWrapper(['acme'], `CLOUDISP_API_BASE=https://127.0.0.1:1\nCLOUDISP_API_KEY=${API_KEY}\nCLOUDISP_TELEGRAM_BOT_TOKEN=${BOT_TOKEN}\nCLOUDISP_REPORT_CHAT_IDS=941533777\n`);

    assert.equal(unreachable.status, 0, unreachable.stderr);
    assert.match(unreachable.stderr, /listing the deliveries failed/);
    assert.match(unreachable.stdout, /delivered=0 pending=0/);
});
