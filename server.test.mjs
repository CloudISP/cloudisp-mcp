/**
 * Tests for the CloudISP MCP stdio server.
 *
 * `node --test server.test.mjs` — no dependencies beyond Node 18+.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { dispatch, startServer } from './server.mjs';

const SERVER_PATH = fileURLToPath(new URL('./server.mjs', import.meta.url));
const API_BASE = 'https://admin.cloudisp.test';
const API_KEY = 'test-bearer-key';

/** Environment with the write guardrail off. */
const WRITES_ON = { ...process.env, CLOUDISP_ALLOW_WRITES: '1' };

process.env.CLOUDISP_API_BASE = API_BASE;
process.env.CLOUDISP_API_KEY = API_KEY;

/**
 * Build a `fetch`-compatible double response.
 *
 * @param {object} payload JSON body.
 * @param {number} [status] HTTP status.
 * @return {object}
 */
function jsonResponse(payload, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

/**
 * Build a `fetch`-compatible double response that carries the API error envelope.
 *
 * @param {number} status HTTP status.
 * @param {object} error Error envelope.
 * @return {object}
 */
function errorResponse(status, error) {
    return jsonResponse({ success: false, error }, status);
}

// ─── dispatch ────────────────────────────────────────────────────────────────

test('change_subscriber_bandwidth with an ambiguous query performs no POST', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url: String(url), method: (init?.method ?? 'GET').toUpperCase() });

        return jsonResponse({
            success: true,
            data: [{ id: 1, first_name: 'Ana', last_name: 'Perez' }, { id: 2, first_name: 'Luis', last_name: 'Perez' }],
            meta: { total: 2 },
        });
    };

    const result = await dispatch(
        'change_subscriber_bandwidth',
        { idempotency_key: 'op-1', query: 'Perez', download_max_limit: 100 },
        fetchImpl,
        WRITES_ON,
    );

    assert.equal(result.error, 'ambiguous_subscriber');
    assert.equal(result.candidates.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
    assert.ok(calls[0].url.startsWith(`${API_BASE}/api/v1/public/subscribers?`));
    assert.ok(calls[0].url.includes('q=Perez'));
});

test('change_subscriber_bandwidth posts once with the Idempotency-Key header', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url: String(url), method, headers: init?.headers ?? {}, body: init?.body });

        if (method === 'GET') {
            return jsonResponse({ success: true, data: [{ id: 42 }], meta: { total: 1 } });
        }

        return jsonResponse({
            success: true,
            data: { id: 42, profile_id: 5, lock_version: 3, replayed: false, provider_sync: 'queued' },
        });
    };

    const result = await dispatch(
        'change_subscriber_bandwidth',
        { idempotency_key: 'op-2', query: 'Perez', profile_id: 5 },
        fetchImpl,
        WRITES_ON,
    );

    assert.equal(result.data.provider_sync, 'queued');

    const posts = calls.filter((call) => call.method === 'POST');
    assert.equal(posts.length, 1);
    assert.ok(posts[0].url.endsWith('/subscribers/42/bandwidth'));
    assert.equal(posts[0].headers['Idempotency-Key'], 'op-2');
    assert.equal(posts[0].headers.Authorization, `Bearer ${API_KEY}`);
    assert.deepEqual(JSON.parse(posts[0].body), { profile_id: 5 });
});

test('change_subscriber_bandwidth rejects two bandwidth targets without any HTTP call', async () => {
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;

        return jsonResponse({ success: true, data: [], meta: { total: 0 } });
    };

    const result = await dispatch(
        'change_subscriber_bandwidth',
        { idempotency_key: 'op-3', subscriber_id: 7, profile_id: 5, download_max_limit: 100 },
        fetchImpl,
        WRITES_ON,
    );

    assert.equal(result.error, 'validation_failed');
    assert.equal(calls, 0);
});

test('assign_installation with one pending installation and one technician posts exactly once to /assign', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const target = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url: target, method, body: init?.body });

        if (target.includes('/subscribers?')) {
            return jsonResponse({ success: true, data: [{ id: 42 }], meta: { total: 1 } });
        }

        if (target.includes('/work-orders?')) {
            assert.ok(target.includes('type=installation'));
            assert.ok(target.includes('status=pending'));

            return jsonResponse({ success: true, data: [{ id: 7, status: 'pending' }], meta: { total: 1 } });
        }

        if (target.includes('/employees?')) {
            return jsonResponse({ success: true, data: [{ id: 9 }], meta: { total: 1 } });
        }

        if (method === 'POST' && target.endsWith('/work-orders/7/assign')) {
            return jsonResponse({ success: true, data: { id: 7, assigned_to: 9, replayed: false } });
        }

        throw new Error(`Unexpected request: ${method} ${target}`);
    };

    const result = await dispatch(
        'assign_installation',
        { subscriber_query: 'Ana Gomez', technician_query: 'Ruiz' },
        fetchImpl,
        WRITES_ON,
    );

    assert.deepEqual(result, { success: true, data: { id: 7, assigned_to: 9, replayed: false } });

    const posts = calls.filter((call) => call.method === 'POST');
    assert.equal(posts.length, 1);
    assert.ok(posts[0].url.endsWith('/assign'));
    assert.deepEqual(JSON.parse(posts[0].body), { employee_id: 9 });
});

test('assign_installation returns the candidates and does not assign when the technician query matches several employees', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const target = String(url);
        calls.push({ url: target, method: (init?.method ?? 'GET').toUpperCase() });

        if (target.includes('/employees?')) {
            return jsonResponse({ success: true, data: [{ id: 9 }, { id: 10 }], meta: { total: 2 } });
        }

        throw new Error(`Unexpected request: ${target}`);
    };

    const result = await dispatch(
        'assign_installation',
        { work_order_id: 7, technician_query: 'Ruiz' },
        fetchImpl,
        WRITES_ON,
    );

    assert.equal(result.error, 'ambiguous_technician');
    assert.equal(result.candidates.length, 2);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('disconnect_subscriber opens the linked work order with the same idempotency token', async () => {
    const bodies = [];
    const fetchImpl = async (url, init) => {
        const target = String(url);

        if (target.endsWith('/subscribers/42/disconnect')) {
            return jsonResponse({
                success: true,
                data: { id: 42, lifecycle_status: 'disconnected', lock_version: 4, replayed: false, provider_sync: 'queued' },
            });
        }

        if (target.endsWith('/work-orders')) {
            bodies.push(JSON.parse(init.body));

            return jsonResponse({ success: true, data: { id: 77, external_ref: 'op-4', replayed: false } });
        }

        throw new Error(`Unexpected request: ${target}`);
    };

    const result = await dispatch(
        'disconnect_subscriber',
        { idempotency_key: 'op-4', subscriber_id: 42, open_work_order: true },
        fetchImpl,
        WRITES_ON,
    );

    assert.equal(result.data.lifecycle_status, 'disconnected');
    assert.equal(result.work_order.data.id, 77);
    assert.deepEqual(bodies, [{
        client_id: 42,
        type: 'technical_service',
        title: 'Desconexión de abonado 42',
        external_ref: 'op-4',
    }]);
});

test('disconnect_subscriber keeps the disconnect body and reports work_order_error without reconnecting', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const target = String(url);
        calls.push({ url: target, method: (init?.method ?? 'GET').toUpperCase() });

        if (target.endsWith('/subscribers/42/disconnect')) {
            return jsonResponse({
                success: true,
                data: { id: 42, lifecycle_status: 'disconnected', lock_version: 4, replayed: false, provider_sync: 'queued' },
            });
        }

        if (target.endsWith('/work-orders')) {
            return errorResponse(409, { code: 'idempotency_conflict', message: 'External ref already used.' });
        }

        if (target.endsWith('/reconnect')) {
            throw new Error('The server must never reconnect.');
        }

        throw new Error(`Unexpected request: ${target}`);
    };

    const result = await dispatch(
        'disconnect_subscriber',
        { idempotency_key: 'op-5', subscriber_id: 42, open_work_order: true },
        fetchImpl,
        WRITES_ON,
    );

    assert.equal(result.data.lifecycle_status, 'disconnected');
    assert.equal(result.work_order_error.error.code, 'idempotency_conflict');
    assert.equal(calls.length, 2);
});

// ─── write guardrail ─────────────────────────────────────────────────────────

test('dispatch refuses every write tool when CLOUDISP_ALLOW_WRITES is unset, with no HTTP call', async () => {
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;

        return jsonResponse({ success: true, data: [], meta: { total: 0 } });
    };

    const attempts = [
        ['change_subscriber_bandwidth', { idempotency_key: 'op-6', subscriber_id: 7, profile_id: 5 }],
        ['disconnect_subscriber', { idempotency_key: 'op-7', subscriber_id: 7 }],
        ['assign_installation', { work_order_id: 7, employee_id: 9 }],
    ];

    for (const [name, args] of attempts) {
        const result = await dispatch(name, args, fetchImpl, { CLOUDISP_API_BASE: API_BASE, CLOUDISP_API_KEY: API_KEY });

        assert.equal(result.error, 'writes_disabled', `${name} must be refused`);
        assert.match(result.message, /CLOUDISP_ALLOW_WRITES=1/);
    }

    assert.equal(calls, 0);
});

test('dispatch still serves read tools when CLOUDISP_ALLOW_WRITES is unset', async () => {
    const result = await dispatch(
        'find_subscriber',
        { query: 'Perez' },
        async () => jsonResponse({ success: true, data: [], meta: { total: 0 } }),
        {},
    );

    assert.equal(result.success, true);
});

// ─── stdio framing ───────────────────────────────────────────────────────────

/**
 * Encode one JSON-RPC message as a newline-terminated line.
 *
 * @param {object} payload JSON-RPC message.
 * @return {string}
 */
function encodeLine(payload) {
    return `${JSON.stringify(payload)}\n`;
}

/**
 * Decode every complete line currently present in accumulated stdout.
 *
 * @param {Buffer} buffer Accumulated stdout.
 * @return {Array<object>} Decoded messages.
 */
function decodeMessages(buffer) {
    const lines = buffer.toString('utf8').split('\n');
    lines.pop();

    return lines
        .map((line) => line.replace(/\r$/, '').trim())
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line));
}

/**
 * Wait until the accumulated stdout holds at least `count` decoded messages.
 *
 * @param {function(): Buffer} readBuffer Buffer accessor.
 * @param {number} count Expected message count.
 * @param {number} [timeoutMs] Deadline.
 * @return {Promise<Array<object>>} Decoded messages.
 */
async function waitForMessages(readBuffer, count, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        const messages = decodeMessages(readBuffer());

        if (messages.length >= count) {
            return messages;
        }

        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${count} message(s); decoded ${messages.length}.`);
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

/**
 * Start the server as a child process and exchange two JSON-RPC lines over stdio.
 *
 * @param {Record<string, string|undefined>} env Child environment.
 * @return {Promise<Array<object>>} The two responses.
 */
async function smokeStdio(env) {
    const childEnv = { ...process.env, CLOUDISP_API_BASE: API_BASE, CLOUDISP_API_KEY: API_KEY };

    for (const [name, value] of Object.entries(env)) {
        if (value === undefined) {
            delete childEnv[name];
        } else {
            childEnv[name] = value;
        }
    }

    const child = spawn(process.execPath, [SERVER_PATH], {
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
        stdout = Buffer.concat([stdout, chunk]);
    });

    child.stdin.write(encodeLine({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
    }));
    child.stdin.write(encodeLine({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    child.stdin.write(encodeLine({ jsonrpc: '2.0', method: 'notifications/initialized' }));

    const messages = await waitForMessages(() => stdout, 2);
    child.kill();

    return messages;
}

test('stdio smoke: newline framing answers initialize and lists the eight tools with writes enabled', async () => {
    const messages = await smokeStdio({ CLOUDISP_ALLOW_WRITES: '1' });

    const initialize = messages.find((message) => message.id === 1);
    assert.equal(initialize.result.protocolVersion, '2025-06-18');
    assert.equal(initialize.result.serverInfo.name, 'cloudisp-mcp');
    assert.equal(initialize.result.serverInfo.version, '0.2.0');
    assert.match(initialize.result.instructions, /CLOUDISP_ALLOW_WRITES=1/);
    assert.ok(initialize.result.capabilities.tools);

    const list = messages.find((message) => message.id === 2);
    assert.ok(Array.isArray(list.result.tools));

    for (const tool of list.result.tools) {
        assert.equal(tool.inputSchema.type, 'object');
        assert.equal(typeof tool.description, 'string');
    }
});

test('stdio smoke: default environment lists exactly the five read tools', async () => {
    const messages = await smokeStdio({ CLOUDISP_ALLOW_WRITES: undefined });

    const list = messages.find((message) => message.id === 2);

    assert.deepEqual(
        list.result.tools.map((tool) => tool.name).sort(),
        [
            'find_subscriber',
            'find_technician',
            'find_work_orders',
            'list_internet_profiles',
            'network_snapshot',
        ],
    );
});

test('stdio: a malformed line answers -32700 and does not kill the stream', async () => {
    const child = spawn(process.execPath, [SERVER_PATH], {
        env: { ...process.env, CLOUDISP_API_BASE: API_BASE, CLOUDISP_API_KEY: API_KEY },
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
        stdout = Buffer.concat([stdout, chunk]);
    });

    child.stdin.write('not json\n');
    child.stdin.write(encodeLine({ jsonrpc: '2.0', id: 1, method: 'ping' }));

    const messages = await waitForMessages(() => stdout, 2);
    child.kill();

    const parseError = messages.find((message) => message.error?.code === -32700);
    assert.ok(parseError, 'a parse error must be answered');
    assert.equal(parseError.id, null);
    assert.ok(messages.some((message) => message.id === 1 && message.result));
});

test('startServer reads newline-delimited messages from an in-process stream', async () => {
    const { PassThrough } = await import('node:stream');
    const input = new PassThrough();
    const output = new PassThrough();
    const written = [];

    output.on('data', (chunk) => written.push(chunk.toString('utf8')));

    startServer({
        input,
        output,
        env: { CLOUDISP_API_BASE: API_BASE, CLOUDISP_API_KEY: API_KEY, CLOUDISP_ALLOW_WRITES: '1' },
        fetchImpl: async () => jsonResponse({ success: true, data: [], meta: { total: 0 } }),
    });

    input.write(encodeLine({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    input.write(encodeLine({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    input.write('\n');
    input.write('{"jsonrpc":"2.0","id":3,"method":"tools/list"}\r\n');

    await new Promise((resolve) => setTimeout(resolve, 50));

    const messages = decodeMessages(Buffer.from(written.join(''), 'utf8'));
    assert.equal(messages.length, 3);
    assert.equal(messages[1].result.tools.length, 8);
    assert.equal(messages[2].result.tools.length, 8);
});

test('tools/call strips document, phone and email from subscriber results', async () => {
    const { PassThrough } = await import('node:stream');
    const input = new PassThrough();
    const output = new PassThrough();
    const written = [];

    output.on('data', (chunk) => written.push(chunk.toString('utf8')));

    startServer({
        input,
        output,
        env: { CLOUDISP_API_BASE: API_BASE, CLOUDISP_API_KEY: API_KEY },
        fetchImpl: async () => jsonResponse({
            success: true,
            data: [{ id: 9, first_name: 'Ana', last_name: 'Gil', document: '27-1', phone: '381', email: 'a@b.c', client: { phone: '381' } }],
            meta: { total: 1 },
        }),
    });

    input.write(encodeLine({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_subscriber', arguments: { query: 'Ana' } } }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const [message] = decodeMessages(Buffer.from(written.join(''), 'utf8'));
    const text = message.result.content[0].text;
    assert.match(text, /"first_name": "Ana"/);
    assert.doesNotMatch(text, /27-1|381|a@b\.c/);
});

test('stdio: initialize without CLOUDISP_API_BASE / CLOUDISP_API_KEY answers -32000 and exits 1', async () => {
    const env = { ...process.env };
    delete env.CLOUDISP_API_BASE;
    delete env.CLOUDISP_API_KEY;

    const child = spawn(process.execPath, [SERVER_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
        stdout = Buffer.concat([stdout, chunk]);
    });

    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    child.stdin.write(encodeLine({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));

    const messages = await waitForMessages(() => stdout, 1);

    assert.equal(messages[0].error.code, -32000);
    assert.match(messages[0].error.message, /CLOUDISP_API_BASE/);
    assert.equal(await exited, 1);
});

test('stdio: initialize with a plain http base on a public host answers -32000 and exits 1', async () => {
    const child = spawn(process.execPath, [SERVER_PATH], {
        env: { ...process.env, CLOUDISP_API_BASE: 'http://example.com', CLOUDISP_API_KEY: API_KEY },
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
        stdout = Buffer.concat([stdout, chunk]);
    });

    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    child.stdin.write(encodeLine({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));

    const messages = await waitForMessages(() => stdout, 1);

    assert.equal(messages[0].error.code, -32000);
    assert.match(messages[0].error.message, /https:\/\//);
    assert.equal(await exited, 1);
});

test('stdio: initialize accepts a plain http base on localhost', async () => {
    const messages = await smokeStdio({ CLOUDISP_API_BASE: 'http://localhost:1' });

    assert.equal(messages.find((message) => message.id === 1).result.serverInfo.name, 'cloudisp-mcp');
});

test('tools/call reports a timeout when the API does not answer in time', async () => {
    const { PassThrough } = await import('node:stream');
    const input = new PassThrough();
    const output = new PassThrough();
    const written = [];

    output.on('data', (chunk) => written.push(chunk.toString('utf8')));

    startServer({
        input,
        output,
        env: { CLOUDISP_API_BASE: API_BASE, CLOUDISP_API_KEY: API_KEY },
        fetchImpl: async () => {
            throw Object.assign(new Error('t'), { name: 'TimeoutError' });
        },
    });

    input.write(encodeLine({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'network_snapshot', arguments: {} } }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const [message] = decodeMessages(Buffer.from(written.join(''), 'utf8'));
    assert.match(message.result.content[0].text, /"error": "timeout"/);
});

test('tools/list annotates read tools as read-only and disconnect as destructive', async () => {
    const readOnly = await smokeStdio({ CLOUDISP_ALLOW_WRITES: undefined });

    for (const tool of readOnly.find((message) => message.id === 2).result.tools) {
        assert.equal(tool.annotations.readOnlyHint, true, tool.name);
        assert.equal(typeof tool.title, 'string');
    }

    const writes = await smokeStdio({ CLOUDISP_ALLOW_WRITES: '1' });
    const disconnect = writes.find((message) => message.id === 2).result.tools.find((tool) => tool.name === 'disconnect_subscriber');
    assert.equal(disconnect.annotations.destructiveHint, true);
    assert.equal(disconnect.annotations.readOnlyHint, false);
});
