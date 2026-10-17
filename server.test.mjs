/**
 * Tests for the CloudISP MCP stdio server.
 *
 * `node --test server.test.mjs` — no dependencies beyond Node 18+.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PassThrough } from 'node:stream';

import { renderGuide, renderWriteTools } from './lib/guide.mjs';
import { awaitTask, dispatch, guideCatalog, listTools, REDACTED_KEYS, startServer, toDisplayTime } from './server.mjs';

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

// ─── fixtures ────────────────────────────────────────────────────────────────

const READ_TOOL_NAMES = [
    'cloudisp_context', 'search_knowledge', 'find_subscriber', 'get_subscriber', 'diagnose_subscriber',
    'onu_read', 'onu_diagnose', 'get_task', 'list_onus', 'list_olts', 'get_olt', 'olt_read',
    'list_routers', 'router_read', 'network_alerts', 'device_metrics', 'platform_logs', 'list_reports',
    'run_report', 'list_internet_profiles', 'list_plans', 'list_invoices', 'find_work_orders',
    'get_work_order', 'find_technician', 'network_snapshot',
    'list_onu_models', 'subscriber_usage', 'usage_ranking', 'device_tasks', 'get_router', 'olt_poll_runs',
    'list_eoc_masters', 'live_traffic', 'export_report', 'build_report',
];

const WRITE_TOOL_NAMES = [
    'reboot_onu', 'set_onu_catv', 'change_subscriber_wifi', 'change_wifi_radio', 'sync_onu',
    'change_subscriber_plan', 'change_subscriber_bandwidth', 'disconnect_subscriber', 'reconnect_subscriber',
    'create_work_order', 'assign_work_order',
    'set_onu_admin_state', 'factory_reset_onu', 'optimize_wifi', 'restore_wifi', 'reprovision_onu', 'kick_pppoe',
    'locate_new_onu', 'swap_onu',
];

/** The operator the agent runtime injects as the hidden `_operator` argument (Telegram DM). */
const OPERATOR = {
    id: '941533777', name: 'Marcos Rivadeo', channel: 'telegram', conversation: 'agent:main:telegram:dm:941533777', profile: 'cloudisp-nvs',
};

/** Arguments every write tool requires. */
const WRITE_ARGS = { idempotency_key: 'op-1', _operator: OPERATOR };

/**
 * Virtual clock for task polling: `sleep` advances `now`, so a 40 s budget costs no real time.
 *
 * @return {{ elapsed: number, now: Function, sleep: Function }}
 */
function virtualClock() {
    const clock = { elapsed: 0, now: () => clock.elapsed, sleep: async (ms) => { clock.elapsed += ms; } };

    return clock;
}

/**
 * Build a recording `fetch` double. `routes` maps `"METHOD /path"` (below `/api/v1/public`, no query string)
 * to a response, or to a function of the recorded call returning one. Any other request throws.
 *
 * @param {Record<string, object|Function>} routes Route table.
 * @return {{ fetchImpl: Function, calls: Array<object> }}
 */
function mockApi(routes) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const parsed = new URL(String(url));
        const call = {
            method: (init?.method ?? 'GET').toUpperCase(),
            path: parsed.pathname.replace('/api/v1/public', ''),
            query: parsed.searchParams,
            headers: init?.headers ?? {},
            body: init?.body === undefined ? undefined : JSON.parse(init.body),
        };
        calls.push(call);

        const route = routes[`${call.method} ${call.path}`];

        if (route === undefined) {
            throw new Error(`Unexpected request: ${call.method} ${call.path}`);
        }

        return typeof route === 'function' ? route(call) : route;
    };

    return { fetchImpl, calls };
}

/**
 * Dispatch a tool against a route table with writes on and a virtual clock.
 *
 * @param {string} name Tool name.
 * @param {object} args Tool arguments.
 * @param {Record<string, object|Function>} [routes] Route table, see {@link mockApi}.
 * @param {object} [clock] Clock seams.
 * @return {Promise<{ result: object, calls: Array<object> }>}
 */
async function run(name, args, routes = {}, clock = virtualClock()) {
    const api = mockApi(routes);
    const result = await dispatch(name, args, api.fetchImpl, WRITES_ON, clock);

    return { result, calls: api.calls };
}

/**
 * @param {Array<object>} calls Recorded calls.
 * @return {string[]} `METHOD /path` of each call, in order.
 */
function sig(calls) {
    return calls.map((call) => `${call.method} ${call.path}`);
}

/**
 * Answer each successive request with the next response, repeating the last one.
 *
 * @param {...object} responses Responses in order.
 * @return {Function} Route function.
 */
function sequence(...responses) {
    let index = 0;

    return () => responses[Math.min(index++, responses.length - 1)];
}

/**
 * A task projection the way `TaskStatusProjection::projectRun` shapes it.
 *
 * @param {number} id Task run id.
 * @param {string} status pending, running, succeeded, failed or canceled.
 * @param {object} [result] Safe result.
 * @param {string|null} [errorCode] Error code of a failed task.
 * @return {object}
 */
function taskProjection(id, status, result = {}, errorCode = null) {
    return {
        success: status === 'succeeded',
        status,
        task_run_id: id,
        request_id: `req-${id}`,
        requested_at: '2026-10-14T10:00:00-03:00',
        finished_at: null,
        error_code: errorCode,
        error_message: null,
        message: '',
        result,
    };
}

/**
 * The 202 a device-task endpoint answers.
 *
 * @param {number} id Task run id.
 * @param {object} [extra] Extra top-level fields (e.g. `replayed`).
 * @return {object}
 */
function accepted(id, extra = {}) {
    return jsonResponse({ success: true, data: { task_run_id: id, request_id: `req-${id}`, status: 'pending', ...extra } }, 202);
}

test('a device task accepted with the id at the top level (no data envelope) is awaited too', async () => {
    const { result, calls } = await run('onu_read', { subscriber_id: 42, operation: 'onu.wan_read' }, {
        'POST /subscribers/42/onu/reads': jsonResponse({ request_id: 'req-3', task_run_id: 3, status: 'pending', replayed: true }, 202),
        'GET /tasks/3': jsonResponse(taskProjection(3, 'succeeded')),
    });

    assert.deepEqual(sig(calls), ['POST /subscribers/42/onu/reads', 'GET /tasks/3']);
    assert.equal(result.task_run_id, 3);
    assert.equal(result.replayed, true);
});

const ONE_SUBSCRIBER = jsonResponse({ success: true, data: [{ id: 42 }], meta: { total: 1 } });

// ─── read tools ──────────────────────────────────────────────────────────────

test('cloudisp_context calls GET /agent/context', async () => {
    const { result, calls } = await run('cloudisp_context', {}, {
        'GET /agent/context': jsonResponse({ success: true, rules: ['regla'], articles: [] }),
    });

    assert.deepEqual(sig(calls), ['GET /agent/context']);
    assert.deepEqual(result.rules, ['regla']);
});

test('search_knowledge searches by text or fetches one article, and rejects anything else without HTTP', async () => {
    const routes = {
        'GET /agent/knowledge': jsonResponse({ success: true, data: [] }),
        'GET /agent/knowledge/5': jsonResponse({ success: true, data: { id: 5 } }),
    };

    const search = await run('search_knowledge', { query: 'wifi' }, routes);
    assert.deepEqual(sig(search.calls), ['GET /agent/knowledge']);
    assert.equal(search.calls[0].query.get('q'), 'wifi');

    const article = await run('search_knowledge', { article_id: 5 }, routes);
    assert.deepEqual(sig(article.calls), ['GET /agent/knowledge/5']);

    for (const args of [{}, { query: 'a' }, { query: 'wifi', article_id: 5 }, { query: 'x'.repeat(101) }]) {
        const refused = await run('search_knowledge', args, routes);

        assert.equal(refused.result.outcome, 'validation_failed', JSON.stringify(args));
        assert.equal(refused.calls.length, 0);
    }
});

test('find_subscriber calls GET /subscribers?q=', async () => {
    const { calls } = await run('find_subscriber', { query: 'Perez' }, { 'GET /subscribers': ONE_SUBSCRIBER });

    assert.deepEqual(sig(calls), ['GET /subscribers']);
    assert.equal(calls[0].query.get('q'), 'Perez');
});

test('find_subscriber: #N looks up that id only; a missing #N is no match; bare digits are a text search', async () => {
    const found = await run('find_subscriber', { query: '#42' }, {
        'GET /subscribers/42': jsonResponse({ success: true, data: { id: 42 } }),
    });
    assert.deepEqual(sig(found.calls), ['GET /subscribers/42']);
    assert.equal(found.result.meta.total, 1);

    const missing = await run('find_subscriber', { query: '#1234' }, {
        'GET /subscribers/1234': errorResponse(404, { code: 'not_found', message: 'Not found.' }),
        'GET /subscribers': ONE_SUBSCRIBER,
    });
    assert.deepEqual(sig(missing.calls), ['GET /subscribers/1234']);
    assert.equal(missing.result.meta.total, 0);

    const bare = await run('find_subscriber', { query: '123456' }, {
        'GET /subscribers/123456': jsonResponse({ success: true, data: { id: 123456 } }),
        'GET /subscribers': ONE_SUBSCRIBER,
    });
    assert.deepEqual(sig(bare.calls), ['GET /subscribers']);
    assert.equal(bare.calls[0].query.get('q'), '123456');
});

test('get_subscriber and diagnose_subscriber GET the subscriber, resolving a query to exactly one first', async () => {
    const routes = {
        'GET /subscribers': ONE_SUBSCRIBER,
        'GET /subscribers/42': jsonResponse({ success: true, data: { id: 42 } }),
        'GET /subscribers/42/diagnosis': jsonResponse({ success: true, data: { billing: null, section_errors: [] } }),
    };

    assert.deepEqual(sig((await run('get_subscriber', { subscriber_id: 42 }, routes)).calls), ['GET /subscribers/42']);
    assert.deepEqual(
        sig((await run('diagnose_subscriber', { subscriber_query: 'Perez' }, routes)).calls),
        ['GET /subscribers', 'GET /subscribers/42/diagnosis'],
    );

    const ambiguous = await run('diagnose_subscriber', { subscriber_query: 'Perez' }, {
        'GET /subscribers': jsonResponse({ success: true, data: [{ id: 1 }, { id: 2 }], meta: { total: 2 } }),
    });
    assert.equal(ambiguous.result.outcome, 'ambiguous_subscriber');
    assert.equal(ambiguous.calls.length, 1);

    const both = await run('get_subscriber', { subscriber_id: 42, subscriber_query: 'Perez' }, routes);
    assert.equal(both.result.outcome, 'validation_failed');
    assert.equal(both.calls.length, 0);
});

test('onu_read posts the operation, polls the task and returns the final projection', async () => {
    const { result, calls } = await run(
        'onu_read',
        { subscriber_id: 42, operation: 'onu.tr069_read', parameters: { refresh: true } },
        {
            'POST /subscribers/42/onu/reads': accepted(9),
            'GET /tasks/9': sequence(
                jsonResponse(taskProjection(9, 'running')),
                jsonResponse(taskProjection(9, 'succeeded', { rx_power_dbm: -19.4 })),
            ),
        },
    );

    assert.deepEqual(sig(calls), ['POST /subscribers/42/onu/reads', 'GET /tasks/9', 'GET /tasks/9']);
    assert.deepEqual(calls[0].body, { operation: 'onu.tr069_read', parameters: { refresh: true } });
    assert.equal(calls[0].headers['Idempotency-Key'], undefined, 'a read carries no idempotency key');
    assert.equal(result.success, true);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.result.rx_power_dbm, -19.4);
});

test('onu_read refuses an operation outside the closed list without any HTTP call', async () => {
    for (const operation of ['onu.reboot', 'onu.wifi_ssid_update', 'onu.lan_dns_read', '', undefined]) {
        const { result, calls } = await run('onu_read', { subscriber_id: 42, operation });

        assert.equal(result.outcome, 'validation_failed', String(operation));
        assert.equal(calls.length, 0);
    }
});

test('onu_read answers the API failure verbatim when the dispatch is refused', async () => {
    const { result, calls } = await run('onu_read', { subscriber_id: 42, operation: 'onu.wan_read' }, {
        'POST /subscribers/42/onu/reads': errorResponse(422, { code: 'onu_not_linked', message: 'No ONU.' }),
    });

    assert.equal(result.outcome, 'onu_not_linked');
    assert.equal(calls.length, 1);
});

test('onu_diagnose posts to /onu/diagnose and awaits the task', async () => {
    const { result, calls } = await run('onu_diagnose', { subscriber_query: 'Perez' }, {
        'GET /subscribers': ONE_SUBSCRIBER,
        'POST /subscribers/42/onu/diagnose': accepted(12),
        'GET /tasks/12': jsonResponse(taskProjection(12, 'failed', {}, 'sync_template_missing')),
    });

    assert.deepEqual(sig(calls), ['GET /subscribers', 'POST /subscribers/42/onu/diagnose', 'GET /tasks/12']);
    assert.equal(result.error_code, 'sync_template_missing');
});

test('get_task calls GET /tasks/{id}', async () => {
    const { result, calls } = await run('get_task', { task_run_id: 9 }, {
        'GET /tasks/9': jsonResponse(taskProjection(9, 'running')),
    });

    assert.deepEqual(sig(calls), ['GET /tasks/9']);
    assert.equal(result.status, 'running');
});

/** Two opaque metric ids as the catalogue hands them out: 64 lowercase hex characters. */
const METRIC_A = 'a'.repeat(64);
const METRIC_B = '0123456789abcdef'.repeat(4);

test('list_onus maps state, subscriber, OLT, PON and paging onto the query string', async () => {
    const { calls } = await run(
        'list_onus',
        { state: 'offline', subscriber_query: 'Perez', olt_id: 6, pon_slot: 0, pon_port: 3, per_page: 100 },
        { 'GET /subscribers': ONE_SUBSCRIBER, 'GET /network/onus': jsonResponse({ success: true, data: [], meta: { total: 0 } }) },
    );

    assert.deepEqual(sig(calls), ['GET /subscribers', 'GET /network/onus']);
    assert.deepEqual(Object.fromEntries(calls[1].query), {
        state: 'offline', client_id: '42', olt_id: '6', pon_slot: '0', pon_port: '3', per_page: '100',
    });
});

test('list_olts, get_olt, list_routers and network_alerts map onto their endpoints', async () => {
    const ok = jsonResponse({ success: true, data: [] });
    const routes = {
        'GET /network/olts': ok, 'GET /network/olts/7': ok, 'GET /network/routers': ok, 'GET /network/alerts': ok,
    };

    assert.deepEqual(sig((await run('list_olts', {}, routes)).calls), ['GET /network/olts']);
    assert.deepEqual(sig((await run('get_olt', { olt_id: 7 }, routes)).calls), ['GET /network/olts/7']);
    assert.deepEqual(sig((await run('list_routers', {}, routes)).calls), ['GET /network/routers']);

    const alerts = await run('network_alerts', { limit: 5 }, routes);
    assert.deepEqual(sig(alerts.calls), ['GET /network/alerts']);
    assert.equal(alerts.calls[0].query.get('limit'), '5');
});

test('olt_read and router_read post to their reads endpoint and await the task', async () => {
    const olt = await run('olt_read', { olt_id: 6, operation: 'olt.health_check' }, {
        'POST /network/olts/6/reads': accepted(20),
        'GET /tasks/20': jsonResponse(taskProjection(20, 'succeeded', { reachable: true })),
    });
    assert.deepEqual(sig(olt.calls), ['POST /network/olts/6/reads', 'GET /tasks/20']);
    assert.deepEqual(olt.calls[0].body, { operation: 'olt.health_check', parameters: {} });
    assert.equal(olt.result.result.reachable, true);

    const router = await run(
        'router_read',
        { router_id: 3, operation: 'routeros.interface_monitor_traffic', parameters: { interface: '<pppoe-ana>' } },
        { 'POST /network/routers/3/reads': accepted(21), 'GET /tasks/21': jsonResponse(taskProjection(21, 'succeeded')) },
    );
    assert.deepEqual(sig(router.calls), ['POST /network/routers/3/reads', 'GET /tasks/21']);
    assert.deepEqual(router.calls[0].body, { operation: 'routeros.interface_monitor_traffic', parameters: { interface: '<pppoe-ana>' } });

    for (const [name, args] of [['olt_read', { olt_id: 6, operation: 'routeros.health_check' }], ['router_read', { router_id: 3, operation: 'olt.poll' }]]) {
        const refused = await run(name, args);

        assert.equal(refused.result.outcome, 'validation_failed', name);
        assert.equal(refused.calls.length, 0);
    }
});

test('device_metrics asks for the catalogue, or for the series with metric_id[]', async () => {
    const ok = jsonResponse({ success: true, data: [] });
    const routes = {
        'GET /network/devices/olt/6/metrics/catalog': ok,
        'GET /network/devices/routeros/3/metrics/series': ok,
    };

    assert.deepEqual(sig((await run('device_metrics', { kind: 'olt', device_id: 6 }, routes)).calls), ['GET /network/devices/olt/6/metrics/catalog']);

    const series = await run(
        'device_metrics',
        { kind: 'routeros', device_id: 3, metric_ids: [METRIC_A, METRIC_B], window: '24h', resolution: 'trend_1h' },
        routes,
    );
    assert.deepEqual(sig(series.calls), ['GET /network/devices/routeros/3/metrics/series']);
    assert.deepEqual(series.calls[0].query.getAll('metric_id[]'), [METRIC_A, METRIC_B]);
    assert.equal(series.calls[0].query.get('window'), '24h');
    assert.equal(series.calls[0].query.get('resolution'), 'trend_1h');

    assert.equal((await run('device_metrics', { kind: 'onu', device_id: 1 }, routes)).result.outcome, 'validation_failed');
});

test('platform_logs sends the platform, the range, the filters and severity[]', async () => {
    const { calls } = await run(
        'platform_logs',
        { platform_id: 3, since: '2026-10-14T08:00:00-03:00', device_kind: 'routeros', device_id: 2, severity: ['error', 'warning'], q: 'ana.perez', limit: 200 },
        { 'GET /logs/events': jsonResponse({ success: true, data: [] }) },
    );

    assert.deepEqual(sig(calls), ['GET /logs/events']);
    assert.equal(calls[0].query.get('platform_id'), '3');
    assert.equal(calls[0].query.get('since'), '2026-10-14T08:00:00-03:00');
    assert.equal(calls[0].query.get('device_kind'), 'routeros');
    assert.equal(calls[0].query.get('device_id'), '2');
    assert.deepEqual(calls[0].query.getAll('severity[]'), ['error', 'warning']);
    assert.equal(calls[0].query.get('q'), 'ana.perez');
    assert.equal(calls[0].query.get('limit'), '200');

    assert.equal((await run('platform_logs', {})).result.outcome, 'validation_failed');
});

test('list_reports and run_report map onto /reports and /reports/{key}', async () => {
    const ok = jsonResponse({ success: true, data: [] });
    const routes = { 'GET /reports': ok, 'GET /reports/onus-offline': ok };

    assert.deepEqual(sig((await run('list_reports', {}, routes)).calls), ['GET /reports']);

    const report = await run('run_report', { key: 'onus-offline', platform_id: 4, filters: { olt_id: 6 } }, routes);
    assert.deepEqual(sig(report.calls), ['GET /reports/onus-offline']);
    assert.equal(report.calls[0].query.get('platform_id'), '4');
    assert.equal(report.calls[0].query.get('olt_id'), '6');

    assert.equal((await run('run_report', { key: '../etc' }, routes)).result.outcome, 'validation_failed');
});

test('list_plans, list_invoices, find_work_orders, get_work_order and find_technician map onto their endpoints', async () => {
    const ok = jsonResponse({ success: true, data: [], meta: { total: 0 } });
    const routes = {
        'GET /plans': ok, 'GET /invoices': ok, 'GET /work-orders': ok, 'GET /work-orders/7': ok, 'GET /employees': ok,
    };

    const plans = await run('list_plans', { status: 'active' }, routes);
    assert.equal(plans.calls[0].query.get('status'), 'active');
    assert.equal(plans.calls[0].query.get('per_page'), '100');

    const invoices = await run('list_invoices', { subscriber_id: 42, status: 'issued' }, routes);
    assert.equal(invoices.calls[0].query.get('subscriber_id'), '42');
    assert.equal(invoices.calls[0].query.get('status'), 'issued');

    const orders = await run('find_work_orders', { subscriber_id: 42, type: 'technical_visit', status: 'pending' }, routes);
    assert.deepEqual(Object.fromEntries(orders.calls[0].query), { client_id: '42', type: 'technical_visit', status: 'pending' });

    assert.deepEqual(sig((await run('get_work_order', { work_order_id: 7 }, routes)).calls), ['GET /work-orders/7']);

    const technician = await run('find_technician', { query: 'Olivera' }, routes);
    assert.deepEqual(Object.fromEntries(technician.calls[0].query), { q: 'Olivera', assignable: '1' });

    const withRole = await run('find_technician', { query: 'Olivera' }, {
        'GET /employees': jsonResponse({ success: true, data: [{ id: 5, name: 'X', role: 'technical' }], meta: { total: 1 } }),
    });
    assert.equal(withRole.result.data[0].role, 'technical');
});

// ─── write tools ─────────────────────────────────────────────────────────────

test('change_subscriber_bandwidth with an ambiguous subscriber_query performs no POST', async () => {
    const { result, calls } = await run(
        'change_subscriber_bandwidth',
        { ...WRITE_ARGS, subscriber_query: 'Perez', download_max_limit: 100 },
        { 'GET /subscribers': jsonResponse({ success: true, data: [{ id: 1 }, { id: 2 }], meta: { total: 2 } }) },
    );

    assert.equal(result.outcome, 'ambiguous_subscriber');
    assert.equal(result.details.length, 2);
    assert.deepEqual(sig(calls), ['GET /subscribers']);
    assert.equal(calls[0].query.get('q'), 'Perez');
    assert.equal(calls[0].headers['X-CloudISP-Requested-By'], 'Marcos Rivadeo', 'the lookup is attributed too');
});

test('change_subscriber_bandwidth posts once with the Idempotency-Key and requester headers', async () => {
    const { result, calls } = await run(
        'change_subscriber_bandwidth',
        { ...WRITE_ARGS, idempotency_key: 'op-2', subscriber_query: 'Perez', profile_id: 5 },
        {
            'GET /subscribers': ONE_SUBSCRIBER,
            'POST /subscribers/42/bandwidth': jsonResponse({ success: true, data: { id: 42, profile_id: 5, provider_sync: 'queued' } }),
        },
    );

    assert.equal(result.data.provider_sync, 'queued');
    assert.deepEqual(sig(calls), ['GET /subscribers', 'POST /subscribers/42/bandwidth']);
    assert.equal(calls[1].headers['Idempotency-Key'], 'op-2');
    assert.equal(calls[1].headers['X-CloudISP-Requested-By'], 'Marcos Rivadeo');
    assert.equal(calls[1].headers.Authorization, `Bearer ${API_KEY}`);
    assert.deepEqual(calls[1].body, { profile_id: 5 });
});

test('change_subscriber_bandwidth rejects two bandwidth targets without any HTTP call', async () => {
    const { result, calls } = await run('change_subscriber_bandwidth', {
        ...WRITE_ARGS, subscriber_id: 7, profile_id: 5, download_max_limit: 100,
    });

    assert.equal(result.outcome, 'validation_failed');
    assert.equal(calls.length, 0);
});

test('reboot_onu posts onu.reboot with the idempotency and requester headers, then awaits the task', async () => {
    const { result, calls } = await run('reboot_onu', { ...WRITE_ARGS, subscriber_id: 42 }, {
        'POST /subscribers/42/onu/actions': accepted(9),
        'GET /tasks/9': jsonResponse(taskProjection(9, 'succeeded')),
    });

    assert.deepEqual(sig(calls), ['POST /subscribers/42/onu/actions', 'GET /tasks/9']);
    assert.deepEqual(calls[0].body, { operation: 'onu.reboot', parameters: {} });
    assert.equal(calls[0].headers['Idempotency-Key'], 'op-1');
    assert.equal(calls[0].headers['X-CloudISP-Requested-By'], 'Marcos Rivadeo');
    assert.equal(result.success, true);
    assert.equal(result.task_run_id, 9);
});

test('reboot_onu keeps the failed projection and the replayed flag of a replay', async () => {
    const { result } = await run('reboot_onu', { ...WRITE_ARGS, subscriber_id: 42 }, {
        'POST /subscribers/42/onu/actions': accepted(9, { replayed: true }),
        'GET /tasks/9': jsonResponse(taskProjection(9, 'failed', {}, 'onu_offline')),
    });

    assert.equal(result.outcome, 'task_failed');
    assert.equal(result.error_code, 'onu_offline');
    assert.equal(result.replayed, true);
});

test('reboot_onu answers a policy refusal verbatim and never polls', async () => {
    const { result, calls } = await run('reboot_onu', { ...WRITE_ARGS, subscriber_id: 42 }, {
        'POST /subscribers/42/onu/actions': errorResponse(403, { code: 'platform_policy_denied', message: 'Read only.' }),
    });

    assert.equal(result.outcome, 'platform_policy_denied');
    assert.equal(calls.length, 1);
});

test('set_onu_catv posts onu.catv_update with the target state', async () => {
    const { calls } = await run('set_onu_catv', { ...WRITE_ARGS, subscriber_id: 42, catv_state: 'disable' }, {
        'POST /subscribers/42/onu/actions': accepted(9),
        'GET /tasks/9': jsonResponse(taskProjection(9, 'succeeded')),
    });

    assert.deepEqual(calls[0].body, { operation: 'onu.catv_update', parameters: { catv_state: 'disable' } });

    const refused = await run('set_onu_catv', { ...WRITE_ARGS, subscriber_id: 42, catv_state: 'on' });
    assert.equal(refused.result.outcome, 'validation_failed');
    assert.equal(refused.calls.length, 0);
});

const WIFI_READ = taskProjection(10, 'succeeded', {
    ssids: [{ index: 1, name: 'Casa', enabled: true, hidden: false, auth_mode: 'wpa2psk', encrypt_type: 'aes' }],
    radios: [{ index: 1, channel: '6' }],
});

test('change_subscriber_wifi reads first and writes with the read task_run_id, filling omitted fields from the read', async () => {
    const { result, calls } = await run(
        'change_subscriber_wifi',
        { ...WRITE_ARGS, subscriber_id: 42, ssid_index: 1, name: 'Nueva', password: 'abc12345' },
        {
            'POST /subscribers/42/onu/reads': accepted(10),
            'GET /tasks/10': jsonResponse(WIFI_READ),
            'POST /subscribers/42/onu/actions': accepted(11),
            'GET /tasks/11': jsonResponse(taskProjection(11, 'succeeded', { ssid_index: 1 })),
        },
    );

    assert.deepEqual(sig(calls), [
        'POST /subscribers/42/onu/reads', 'GET /tasks/10', 'POST /subscribers/42/onu/actions', 'GET /tasks/11',
    ]);
    assert.deepEqual(calls[0].body, { operation: 'onu.wifi_read', parameters: {} });
    assert.deepEqual(calls[2].body, {
        operation: 'onu.wifi_ssid_update',
        parameters: {
            ssid_index: 1, enabled: true, name: 'Nueva', hidden: false, auth_mode: 'wpa2psk', encrypt_type: 'aes',
            password: 'abc12345', based_on_task_run_id: 10,
        },
    });
    assert.equal(calls[2].headers['Idempotency-Key'], 'op-1');
    assert.equal(calls[0].headers['X-CloudISP-Requested-By'], 'Marcos Rivadeo');
    assert.equal(result.task_run_id, 11);
});

test('change_subscriber_wifi never writes when the read failed, did not finish, or lacks the SSID', async () => {
    const base = { ...WRITE_ARGS, subscriber_id: 42, ssid_index: 1, name: 'Nueva' };
    const reads = { 'POST /subscribers/42/onu/reads': accepted(10) };

    const failed = await run('change_subscriber_wifi', base, {
        ...reads, 'GET /tasks/10': jsonResponse(taskProjection(10, 'failed', {}, 'onu_offline')),
    });
    assert.equal(failed.result.error_code, 'onu_offline');
    assert.deepEqual(sig(failed.calls), ['POST /subscribers/42/onu/reads', 'GET /tasks/10']);

    const pending = await run('change_subscriber_wifi', base, {
        ...reads, 'GET /tasks/10': jsonResponse(taskProjection(10, 'running')),
    });
    assert.equal(pending.result.outcome, 'wifi_read_pending');
    assert.equal(pending.calls.some((call) => call.path.endsWith('/onu/actions')), false);

    const missing = await run('change_subscriber_wifi', { ...base, ssid_index: 3 }, {
        ...reads, 'GET /tasks/10': jsonResponse(WIFI_READ),
    });
    assert.equal(missing.result.outcome, 'validation_failed');
    assert.equal(missing.calls.some((call) => call.path.endsWith('/onu/actions')), false);
});

test('change_wifi_radio reads first and writes the radio with the read task_run_id', async () => {
    const { result, calls } = await run(
        'change_wifi_radio',
        { ...WRITE_ARGS, subscriber_id: 42, radio_index: 1, channel: 11, width: '20MHz' },
        {
            'POST /subscribers/42/onu/reads': accepted(10),
            'GET /tasks/10': jsonResponse(WIFI_READ),
            'POST /subscribers/42/onu/actions': accepted(11),
            'GET /tasks/11': jsonResponse(taskProjection(11, 'succeeded')),
        },
    );

    assert.deepEqual(sig(calls), [
        'POST /subscribers/42/onu/reads', 'GET /tasks/10', 'POST /subscribers/42/onu/actions', 'GET /tasks/11',
    ]);
    assert.deepEqual(calls[2].body, {
        operation: 'onu.wifi_radio_update',
        parameters: { radio_index: 1, channel: '11', width: '20MHz', based_on_task_run_id: 10 },
    });
    assert.equal(result.task_run_id, 11);

    const refused = await run('change_wifi_radio', { ...WRITE_ARGS, subscriber_id: 42, radio_index: 3, channel: 'auto' });
    assert.equal(refused.result.outcome, 'validation_failed');
    assert.equal(refused.calls.length, 0);
});

test('sync_onu posts to /onu/sync with the idempotency key and awaits the task', async () => {
    const { result, calls } = await run('sync_onu', { ...WRITE_ARGS, subscriber_query: 'Perez' }, {
        'GET /subscribers': ONE_SUBSCRIBER,
        'POST /subscribers/42/onu/sync': accepted(30),
        'GET /tasks/30': jsonResponse(taskProjection(30, 'succeeded')),
    });

    assert.deepEqual(sig(calls), ['GET /subscribers', 'POST /subscribers/42/onu/sync', 'GET /tasks/30']);
    assert.equal(calls[1].headers['Idempotency-Key'], 'op-1');
    assert.equal(result.task_run_id, 30);
});

test('change_subscriber_plan posts plan_id to /plan', async () => {
    const { calls } = await run('change_subscriber_plan', { ...WRITE_ARGS, subscriber_id: 42, plan_id: 8 }, {
        'POST /subscribers/42/plan': jsonResponse({ success: true, data: { id: 42, plan_id: 8 } }),
    });

    assert.deepEqual(sig(calls), ['POST /subscribers/42/plan']);
    assert.deepEqual(calls[0].body, { plan_id: 8 });
    assert.equal(calls[0].headers['Idempotency-Key'], 'op-1');

    assert.equal((await run('change_subscriber_plan', { ...WRITE_ARGS, subscriber_id: 42 })).result.outcome, 'validation_failed');
});

test('disconnect_subscriber sends the scope and opens the linked work order with the same idempotency token', async () => {
    const { result, calls } = await run(
        'disconnect_subscriber',
        { ...WRITE_ARGS, idempotency_key: 'op-4', subscriber_id: 42, scope: 'all', open_work_order: true },
        {
            'POST /subscribers/42/disconnect': jsonResponse({
                success: true,
                data: { id: 42, lifecycle_status: 'disconnected', replayed: false, provider_sync: 'queued' },
            }),
            'POST /work-orders': jsonResponse({ success: true, data: { id: 77, external_ref: 'op-4', replayed: false } }),
        },
    );

    assert.equal(result.data.lifecycle_status, 'disconnected');
    assert.equal(result.work_order.data.id, 77);
    assert.deepEqual(calls[0].body, { scope: 'all' });
    assert.equal(calls[0].headers['Idempotency-Key'], 'op-4');
    assert.deepEqual(calls[1].body, {
        client_id: 42, type: 'technical_service', title: 'Desconexión de abonado 42', external_ref: 'op-4',
    });
    assert.equal(calls[1].headers['X-CloudISP-Requested-By'], 'Marcos Rivadeo');
});

test('disconnect_subscriber defaults the scope to internet and rejects an unknown one without HTTP', async () => {
    const { calls } = await run('disconnect_subscriber', { ...WRITE_ARGS, subscriber_id: 42 }, {
        'POST /subscribers/42/disconnect': jsonResponse({ success: true, data: { id: 42 } }),
    });
    assert.deepEqual(calls[0].body, { scope: 'internet' });

    const refused = await run('disconnect_subscriber', { ...WRITE_ARGS, subscriber_id: 42, scope: 'wifi' });
    assert.equal(refused.result.outcome, 'validation_failed');
    assert.equal(refused.calls.length, 0);
});

test('disconnect_subscriber keeps the disconnect body and reports work_order_error without reconnecting', async () => {
    const { result, calls } = await run(
        'disconnect_subscriber',
        { ...WRITE_ARGS, idempotency_key: 'op-5', subscriber_id: 42, open_work_order: true },
        {
            'POST /subscribers/42/disconnect': jsonResponse({ success: true, data: { id: 42, lifecycle_status: 'disconnected' } }),
            'POST /work-orders': errorResponse(409, { code: 'idempotency_conflict', message: 'External ref already used.' }),
        },
    );

    assert.equal(result.data.lifecycle_status, 'disconnected');
    assert.equal(result.work_order_error.error.code, 'idempotency_conflict');
    assert.deepEqual(sig(calls), ['POST /subscribers/42/disconnect', 'POST /work-orders']);
});

test('reconnect_subscriber posts the scope to /reconnect and returns an illegal_transition verbatim', async () => {
    const ok = await run('reconnect_subscriber', { ...WRITE_ARGS, subscriber_id: 42, scope: 'catv' }, {
        'POST /subscribers/42/reconnect': jsonResponse({ success: true, data: { id: 42, lifecycle_status: 'active' } }),
    });
    assert.deepEqual(sig(ok.calls), ['POST /subscribers/42/reconnect']);
    assert.deepEqual(ok.calls[0].body, { scope: 'catv' });
    assert.equal(ok.calls[0].headers['Idempotency-Key'], 'op-1');

    const refused = await run('reconnect_subscriber', { ...WRITE_ARGS, subscriber_id: 42 }, {
        'POST /subscribers/42/reconnect': errorResponse(409, { code: 'illegal_transition', message: 'Debt cutoff.', details: { availability: { open_cutoff: true } } }),
    });
    assert.equal(refused.result.outcome, 'illegal_transition');
    assert.equal(refused.result.details.availability.open_cutoff, true);
});

test('create_work_order posts the order with the idempotency key as external_ref', async () => {
    const { calls } = await run(
        'create_work_order',
        { ...WRITE_ARGS, idempotency_key: 'op-9', subscriber_query: 'Perez', type: 'technical_visit', title: 'Visita técnica', description: 'ONU sin reinicio remoto.' },
        { 'GET /subscribers': ONE_SUBSCRIBER, 'POST /work-orders': jsonResponse({ success: true, data: { id: 77 } }) },
    );

    assert.deepEqual(sig(calls), ['GET /subscribers', 'POST /work-orders']);
    assert.deepEqual(calls[1].body, {
        client_id: 42, type: 'technical_visit', title: 'Visita técnica', description: 'ONU sin reinicio remoto.', external_ref: 'op-9',
    });
    assert.equal(calls[1].headers['Idempotency-Key'], 'op-9');

    for (const args of [{ title: 'x' }, { type: 'other' }, { type: 'other', title: 'x', idempotency_key: 'k'.repeat(101) }]) {
        const refused = await run('create_work_order', { ...WRITE_ARGS, subscriber_id: 42, ...args });

        assert.equal(refused.result.outcome, 'validation_failed', JSON.stringify(args));
        assert.equal(refused.calls.length, 0);
    }
});

test('assign_work_order resolves one pending order of the type and one technician, then posts exactly once to /assign', async () => {
    const { result, calls } = await run(
        'assign_work_order',
        { ...WRITE_ARGS, subscriber_query: 'Ana Gomez', type: 'technical_visit', technician_query: 'Olivera' },
        {
            'GET /subscribers': ONE_SUBSCRIBER,
            'GET /work-orders': jsonResponse({ success: true, data: [{ id: 7, status: 'pending' }], meta: { total: 1 } }),
            'GET /employees': jsonResponse({ success: true, data: [{ id: 9 }], meta: { total: 1 } }),
            'POST /work-orders/7/assign': jsonResponse({ success: true, data: { id: 7, assigned_to: 9, replayed: false } }),
        },
    );

    assert.deepEqual(result, { success: true, data: { id: 7, assigned_to: 9, replayed: false } });
    assert.deepEqual(sig(calls), ['GET /subscribers', 'GET /work-orders', 'GET /employees', 'POST /work-orders/7/assign']);
    assert.deepEqual(Object.fromEntries(calls[1].query), { client_id: '42', type: 'technical_visit', status: 'pending' });
    assert.deepEqual(calls[3].body, { employee_id: 9 });
    assert.equal(calls[3].headers['Idempotency-Key'], 'op-1');
    assert.equal(calls[3].headers['X-CloudISP-Requested-By'], 'Marcos Rivadeo');
});

test('assign_work_order returns the candidates and does not assign when a lookup is ambiguous', async () => {
    const technicians = await run(
        'assign_work_order',
        { ...WRITE_ARGS, work_order_id: 7, technician_query: 'Ruiz' },
        { 'GET /employees': jsonResponse({ success: true, data: [{ id: 9 }, { id: 10 }], meta: { total: 2 } }) },
    );
    assert.equal(technicians.result.outcome, 'ambiguous_technician');
    assert.equal(technicians.result.details.length, 2);
    assert.equal(technicians.calls.filter((call) => call.method === 'POST').length, 0);

    const orders = await run(
        'assign_work_order',
        { ...WRITE_ARGS, subscriber_id: 42, type: 'installation', employee_id: 9 },
        { 'GET /work-orders': jsonResponse({ success: true, data: [{ id: 7 }, { id: 8 }], meta: { total: 2 } }) },
    );
    assert.equal(orders.result.outcome, 'ambiguous_work_order');
    assert.equal(orders.calls.filter((call) => call.method === 'POST').length, 0);

    const untyped = await run('assign_work_order', { ...WRITE_ARGS, subscriber_id: 42, employee_id: 9 });
    assert.equal(untyped.result.outcome, 'validation_failed');
    assert.equal(untyped.calls.length, 0);
});

test('assign_installation no longer exists', async () => {
    const { result, calls } = await run('assign_installation', { work_order_id: 7, employee_id: 9 });

    assert.equal(result.error, 'unknown_tool');
    assert.equal(calls.length, 0);
});

// ─── _operator ───────────────────────────────────────────────────────────────

const REQUIRE_OPERATOR = { ...WRITES_ON, CLOUDISP_REQUIRE_OPERATOR: '1' };

test('with CLOUDISP_REQUIRE_OPERATOR=1 every write tool refuses a missing or malformed _operator without any HTTP call', async () => {
    const malformed = [undefined, {}, { id: '', channel: 'telegram' }, { id: '941533777' }, { id: 'a b', channel: 'telegram' }, { id: '9', channel: 'Tele gram' }, 'telegram:9'];

    for (const name of WRITE_TOOL_NAMES) {
        for (const _operator of malformed) {
            const api = mockApi({});
            const result = await dispatch(name, { idempotency_key: 'op-1', subscriber_id: 42, _operator }, api.fetchImpl, REQUIRE_OPERATOR, virtualClock());

            assert.equal(result.ok, false, name);
            assert.equal(result.outcome, 'operator_required', name);
            assert.equal(result.hint, 'No se pudo identificar al operador; la acción no se ejecutó.', name);
            assert.equal(api.calls.length, 0, name);
        }
    }
});

test('without CLOUDISP_REQUIRE_OPERATOR a write still goes out, carrying only the tool header', async () => {
    const { calls } = await run('change_subscriber_plan', { idempotency_key: 'op-1', subscriber_id: 42, plan_id: 8 }, {
        'POST /subscribers/42/plan': jsonResponse({ success: true, data: {} }),
    });

    assert.equal(calls[0].headers['X-CloudISP-Tool'], 'change_subscriber_plan');
    assert.equal(calls[0].headers['X-CloudISP-Operator-Id'], undefined);
    assert.equal(calls[0].headers['X-CloudISP-Requested-By'], undefined);
});

test('every write tool refuses a missing idempotency_key without any HTTP call', async () => {
    for (const name of WRITE_TOOL_NAMES) {
        const { result, calls } = await run(name, { _operator: OPERATOR, subscriber_id: 42 });

        assert.equal(result.outcome, 'validation_failed', name);
        assert.match(result.message, /idempotency_key/, name);
        assert.equal(calls.length, 0, name);
    }
});

test('the _operator reaches the API as the five identity headers, on every request of the call', async () => {
    const { calls } = await run('change_subscriber_bandwidth', { ...WRITE_ARGS, subscriber_query: 'Perez', profile_id: 5 }, {
        'GET /subscribers': ONE_SUBSCRIBER,
        'POST /subscribers/42/bandwidth': jsonResponse({ success: true, data: {} }),
    });

    assert.equal(calls.length, 2);

    for (const call of calls) {
        assert.equal(call.headers['X-CloudISP-Operator-Id'], 'telegram:941533777');
        assert.equal(call.headers['X-CloudISP-Requested-By'], 'Marcos Rivadeo');
        assert.equal(call.headers['X-CloudISP-Channel'], 'telegram');
        assert.equal(call.headers['X-CloudISP-Conversation'], 'agent:main:telegram:dm:941533777');
        assert.equal(call.headers['X-CloudISP-Tool'], 'change_subscriber_bandwidth');
    }
});

test('the operator name is ASCII-folded and cut to 120 characters; an empty name falls back to the operator ref', async () => {
    const routes = { 'POST /subscribers/42/plan': jsonResponse({ success: true, data: {} }) };
    const args = { idempotency_key: 'op-1', subscriber_id: 42, plan_id: 8 };
    const accented = await run('change_subscriber_plan', { ...args, _operator: { ...OPERATOR, name: 'Peña Ñandú 🚀' } }, routes);
    const long = await run('change_subscriber_plan', { ...args, _operator: { ...OPERATOR, name: 'x'.repeat(300) } }, routes);
    const unnamed = await run('change_subscriber_plan', { ...args, _operator: { ...OPERATOR, name: '🚀' } }, routes);

    assert.equal(accented.calls[0].headers['X-CloudISP-Requested-By'], 'Pena Nandu');
    assert.equal(long.calls[0].headers['X-CloudISP-Requested-By'].length, 120);
    assert.equal(unnamed.calls[0].headers['X-CloudISP-Requested-By'], 'telegram:941533777');
});

test('the channel header is sent only for telegram, cli and api; the conversation is cut to 128 printable characters', async () => {
    const routes = { 'GET /subscribers': ONE_SUBSCRIBER };
    const matrix = await run('find_subscriber', { query: 'Perez', _operator: { ...OPERATOR, channel: 'matrix', conversation: `a\nb${'c'.repeat(200)}` } }, routes);
    const cli = await run('find_subscriber', { query: 'Perez', _operator: { ...OPERATOR, channel: 'cli' } }, routes);

    assert.equal(matrix.calls[0].headers['X-CloudISP-Operator-Id'], 'matrix:941533777');
    assert.equal(matrix.calls[0].headers['X-CloudISP-Channel'], undefined);
    assert.equal(matrix.calls[0].headers['X-CloudISP-Conversation'].length, 128);
    assert.ok(!/[\x00-\x1f]/.test(matrix.calls[0].headers['X-CloudISP-Conversation']));
    assert.equal(cli.calls[0].headers['X-CloudISP-Channel'], 'cli');
});

test('read tools carry the tool header always and the identity headers when the operator is known', async () => {
    const anonymous = await run('find_subscriber', { query: 'Perez' }, { 'GET /subscribers': ONE_SUBSCRIBER });
    const known = await run('find_subscriber', { query: 'Perez', _operator: OPERATOR }, { 'GET /subscribers': ONE_SUBSCRIBER });

    assert.deepEqual(Object.keys(anonymous.calls[0].headers).filter((name) => name.startsWith('X-CloudISP-')), ['X-CloudISP-Tool']);
    assert.equal(anonymous.calls[0].headers['X-CloudISP-Tool'], 'find_subscriber');
    assert.equal(known.calls[0].headers['X-CloudISP-Operator-Id'], 'telegram:941533777');
});

test('_operator is stripped before the handler: it never reaches a query string or a body', async () => {
    const { calls } = await run('find_subscriber', { query: 'Perez', _operator: OPERATOR }, { 'GET /subscribers': ONE_SUBSCRIBER });
    const write = await run('change_subscriber_plan', { ...WRITE_ARGS, subscriber_id: 42, plan_id: 8 }, { 'POST /subscribers/42/plan': jsonResponse({ success: true, data: {} }) });

    assert.equal(calls[0].query.has('_operator'), false);
    assert.deepEqual(write.calls[0].body, { plan_id: 8 });
});

// ─── awaitTask ───────────────────────────────────────────────────────────────

test('awaitTask gives up after 40 s of virtual time and answers pending with the task id', async () => {
    const clock = virtualClock();
    let polls = 0;
    const fetchImpl = async () => {
        polls += 1;

        return jsonResponse(taskProjection(5, 'running'));
    };

    const result = await awaitTask(fetchImpl, 5, clock);

    assert.deepEqual(result, { status: 'pending', task_run_id: 5 });
    assert.equal(clock.elapsed, 40000);
    assert.equal(polls, 21, 'one poll every 2 s from 0 s to 40 s');
});

test('awaitTask stops at the first final status, and reports a failed poll with the task id', async () => {
    const clock = virtualClock();
    const done = await awaitTask(async () => jsonResponse(taskProjection(5, 'failed', {}, 'olt_rejected')), 5, clock);

    assert.equal(done.error_code, 'olt_rejected');
    assert.equal(clock.elapsed, 0);

    const missing = await awaitTask(async () => errorResponse(404, { code: 'task_not_found', message: 'No task.' }), 5, clock);

    assert.equal(missing.error.code, 'task_not_found');
    assert.equal(missing.task_run_id, 5);

    const hiccup = await awaitTask(async () => { throw new Error('socket hang up'); }, 5, clock);

    assert.deepEqual(hiccup, { status: 'pending', task_run_id: 5 });
});

// ─── write guardrail ─────────────────────────────────────────────────────────

test('dispatch refuses every write tool when CLOUDISP_ALLOW_WRITES is unset, with no HTTP call', async () => {
    const api = mockApi({});

    for (const name of WRITE_TOOL_NAMES) {
        const result = await dispatch(
            name,
            { ...WRITE_ARGS, subscriber_id: 7 },
            api.fetchImpl,
            { CLOUDISP_API_BASE: API_BASE, CLOUDISP_API_KEY: API_KEY },
        );

        assert.equal(result.outcome, 'writes_disabled', `${name} must be refused`);
        assert.match(result.message, /CLOUDISP_ALLOW_WRITES=1/);
    }

    assert.equal(api.calls.length, 0);
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

// ─── catalogue ───────────────────────────────────────────────────────────────

/**
 * `tools/list` answered by an in-process server.
 *
 * @param {Record<string, string|undefined>} env Environment bag.
 * @return {Promise<Array<object>>} Listed tools.
 */
async function listedTools(env) {
    const input = new PassThrough();
    const output = new PassThrough();
    const written = [];

    output.on('data', (chunk) => written.push(chunk.toString('utf8')));
    startServer({ input, output, env: { CLOUDISP_API_BASE: API_BASE, CLOUDISP_API_KEY: API_KEY, ...env }, fetchImpl: mockApi({}).fetchImpl });
    input.write(encodeLine({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    return decodeMessages(Buffer.from(written.join(''), 'utf8')).find((message) => message.id === 1).result.tools;
}

test('tools/list exposes the full catalogue with writes on and only the reads without', async () => {
    const all = await listedTools({ CLOUDISP_ALLOW_WRITES: '1' });
    const reads = await listedTools({ CLOUDISP_ALLOW_WRITES: undefined });

    assert.deepEqual(all.map((tool) => tool.name).sort(), [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES].sort());
    assert.deepEqual(reads.map((tool) => tool.name).sort(), [...READ_TOOL_NAMES].sort());
});

test('annotations: every read is read-only (device reads included), every write is not, and only the destructive writes are flagged', async () => {
    const tools = await listedTools({ CLOUDISP_ALLOW_WRITES: '1' });

    for (const tool of tools) {
        assert.equal(typeof tool.title, 'string', tool.name);
        assert.equal(tool.annotations.readOnlyHint, READ_TOOL_NAMES.includes(tool.name), tool.name);
    }

    for (const name of ['onu_read', 'onu_diagnose', 'olt_read', 'router_read', 'live_traffic']) {
        assert.equal(tools.find((tool) => tool.name === name).annotations.readOnlyHint, true, name);
    }

    // The destructive writes are exactly these: they cut service, wipe the ONU or drop a live session.
    const destructive = ['change_subscriber_bandwidth', 'disconnect_subscriber', 'reconnect_subscriber', 'factory_reset_onu', 'kick_pppoe'];

    for (const tool of tools) {
        assert.equal(tool.annotations.destructiveHint, destructive.includes(tool.name), tool.name);
    }
});

test('every write tool starts with the confirmation prefix and requires only idempotency_key; no schema exposes the operator', async () => {
    const tools = await listedTools({ CLOUDISP_ALLOW_WRITES: '1' });

    for (const name of WRITE_TOOL_NAMES) {
        const tool = tools.find((candidate) => candidate.name === name);

        assert.ok(tool.description.startsWith('ESCRITURA (requiere confirmación del operador): '), name);
        assert.ok(tool.inputSchema.required.includes('idempotency_key'), name);
        assert.ok(!tool.inputSchema.required.includes('requested_by'), name);
        assert.ok(!('requested_by' in tool.inputSchema.properties), name);
    }

    for (const name of READ_TOOL_NAMES) {
        assert.ok(!tools.find((candidate) => candidate.name === name).description.startsWith('ESCRITURA'), name);
    }

    for (const tool of tools) {
        assert.ok(!('_operator' in tool.inputSchema.properties), tool.name);
    }
});

test('every tool that takes a subscriber offers subscriber_id and subscriber_query', async () => {
    const tools = await listedTools({ CLOUDISP_ALLOW_WRITES: '1' });
    const bySubscriber = ['get_subscriber', 'diagnose_subscriber', 'onu_read', 'onu_diagnose', 'list_onus', 'list_invoices', 'find_work_orders',
        'subscriber_usage', 'device_tasks', 'live_traffic', 'reboot_onu', 'set_onu_catv', 'change_subscriber_wifi', 'change_wifi_radio', 'sync_onu',
        'set_onu_admin_state', 'factory_reset_onu', 'optimize_wifi', 'restore_wifi', 'reprovision_onu', 'kick_pppoe', 'locate_new_onu', 'swap_onu',
        'change_subscriber_plan', 'change_subscriber_bandwidth', 'disconnect_subscriber', 'reconnect_subscriber', 'create_work_order', 'assign_work_order'];

    for (const name of bySubscriber) {
        const { properties } = tools.find((tool) => tool.name === name).inputSchema;

        assert.ok(properties.subscriber_id && properties.subscriber_query, name);
    }
});

test('initialize hands over the condensed core rules, cloudisp_context first', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written = [];

    output.on('data', (chunk) => written.push(chunk.toString('utf8')));
    startServer({ input, output, env: { CLOUDISP_API_BASE: API_BASE, CLOUDISP_API_KEY: API_KEY }, fetchImpl: mockApi({}).fetchImpl });
    input.write(encodeLine({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const { instructions, serverInfo } = decodeMessages(Buffer.from(written.join(''), 'utf8'))[0].result;

    assert.equal(serverInfo.version, '0.5.3');
    assert.ok(instructions.startsWith('Llamá cloudisp_context al iniciar cada conversación y antes de delegar'));
    assert.equal(instructions.split('\n').length, 6);
});

test('redaction strips password, psk and wifi_password (nested) along with document, phone and email', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written = [];

    for (const key of ['document', 'phone', 'email', 'password', 'psk', 'wifi_password']) {
        assert.ok(REDACTED_KEYS.has(key), key);
    }

    output.on('data', (chunk) => written.push(chunk.toString('utf8')));
    startServer({
        input,
        output,
        env: { CLOUDISP_API_BASE: API_BASE, CLOUDISP_API_KEY: API_KEY },
        fetchImpl: mockApi({
            'GET /tasks/9': jsonResponse(taskProjection(9, 'succeeded', {
                ssids: [{ index: 1, name: 'Casa', password: 'S3cr3t-pass', psk: 'S3cr3t-psk', nested: { wifi_password: 'S3cr3t-wifi' } }],
            })),
        }).fetchImpl,
    });
    input.write(encodeLine({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_task', arguments: { task_run_id: 9 } } }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const text = decodeMessages(Buffer.from(written.join(''), 'utf8'))[0].result.content[0].text;

    assert.match(text, /"name": "Casa"/);
    assert.doesNotMatch(text, /S3cr3t/);
});

test('tools/call returns a failed task as an outcome, not an error', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written = [];

    output.on('data', (chunk) => written.push(chunk.toString('utf8')));
    startServer({
        input,
        output,
        env: { CLOUDISP_API_BASE: API_BASE, CLOUDISP_API_KEY: API_KEY },
        fetchImpl: mockApi({
            'GET /tasks/1': jsonResponse(taskProjection(1, 'running')),
            'GET /tasks/2': jsonResponse(taskProjection(2, 'failed', {}, 'onu_offline')),
        }).fetchImpl,
    });

    for (const id of [1, 2]) {
        input.write(encodeLine({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_task', arguments: { task_run_id: id } } }));
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    const messages = decodeMessages(Buffer.from(written.join(''), 'utf8'));

    assert.equal(messages.find((message) => message.id === 1).result.isError, false);
    assert.equal(messages.find((message) => message.id === 2).result.isError, false);
});

test('expected refusals are outcomes: ok:false, no top-level error, no isError', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written = [];

    output.on('data', (chunk) => written.push(chunk.toString('utf8')));
    startServer({
        input,
        output,
        env: { CLOUDISP_API_BASE: API_BASE, CLOUDISP_API_KEY: API_KEY, CLOUDISP_ALLOW_WRITES: '1' },
        fetchImpl: mockApi({
            'GET /tasks/7': errorResponse(404, { code: 'task_not_found', message: 'No task.' }),
            'GET /network/alerts': errorResponse(503, { code: 'source_unavailable', message: 'Loki down.' }),
        }).fetchImpl,
    });

    const calls = [
        ['get_task', { task_run_id: 7 }],
        ['network_alerts', {}],
        ['find_subscriber', { query: '' }],
    ];

    calls.forEach(([name, args], index) => {
        input.write(encodeLine({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name, arguments: args } }));
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const messages = decodeMessages(Buffer.from(written.join(''), 'utf8'));
    const bodies = [1, 2, 3].map((id) => {
        const { result } = messages.find((message) => message.id === id);

        assert.equal(result.isError, false);

        return JSON.parse(result.content[0].text);
    });

    for (const body of bodies) {
        assert.equal(Object.hasOwn(body, 'error'), false);
        assert.equal(body.ok, false);
        assert.equal(typeof body.hint, 'string');
    }

    assert.deepEqual(bodies.map((body) => body.outcome), ['task_not_found', 'source_unavailable', 'validation_failed']);
    assert.equal(bodies[0].message, 'No task.');
});

test('transport-level failures stay tool errors: 401, 500, non-JSON', async () => {
    for (const response of [
        errorResponse(401, { code: 'unauthorized', message: 'Bad key.' }),
        errorResponse(500, { code: 'internal_error', message: 'Boom.' }),
        errorResponse(503, { code: 'dispatch_failed', message: 'Netwatcher down.' }),
        { ok: false, status: 502, json: async () => { throw new Error('html'); } },
    ]) {
        const { result } = await run('get_task', { task_run_id: 1 }, { 'GET /tasks/1': response });

        assert.equal(typeof result.error, 'object', String(response.status));
        assert.equal(result.outcome, undefined);
    }
});

test('a failed task is an outcome with its error_code', async () => {
    const { result } = await run('get_task', { task_run_id: 3 }, { 'GET /tasks/3': jsonResponse(taskProjection(3, 'failed', {}, 'onu_offline')) });

    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'task_failed');
    assert.equal(result.error_code, 'onu_offline');
    assert.equal(Object.hasOwn(result, 'error'), false);
});

test('router_read accepts only the three executable operations and validates the test_command', async () => {
    const tool = listTools(WRITES_ON).find((candidate) => candidate.name === 'router_read');

    assert.deepEqual(tool.inputSchema.properties.operation.enum, ['routeros.health_check', 'routeros.test_command', 'routeros.interface_monitor_traffic']);

    for (const args of [
        { router_id: 3, operation: 'routeros.resource_read' },
        { router_id: 3, operation: 'routeros.test_command' },
        { router_id: 3, operation: 'routeros.test_command', command: '/system/reboot' },
    ]) {
        const refused = await run('router_read', args);

        assert.equal(refused.result.outcome, 'validation_failed', JSON.stringify(args));
        assert.equal(refused.calls.length, 0);
    }

    const ok = await run('router_read', { router_id: 3, operation: 'routeros.test_command', command: '/interface/print' }, {
        'POST /network/routers/3/reads': accepted(30),
        'GET /tasks/30': jsonResponse(taskProjection(30, 'succeeded')),
    });

    assert.deepEqual(ok.calls[0].body, { operation: 'routeros.test_command', parameters: { command: '/interface/print' } });
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

test('stdio smoke: newline framing answers initialize and lists every tool with writes enabled', async () => {
    const messages = await smokeStdio({ CLOUDISP_ALLOW_WRITES: '1' });

    const initialize = messages.find((message) => message.id === 1);
    assert.equal(initialize.result.protocolVersion, '2025-06-18');
    assert.equal(initialize.result.serverInfo.name, 'cloudisp-mcp');
    assert.equal(initialize.result.serverInfo.version, '0.5.3');
    assert.match(initialize.result.instructions, /CLOUDISP_ALLOW_WRITES=1/);
    assert.ok(initialize.result.capabilities.tools);

    const list = messages.find((message) => message.id === 2);
    assert.ok(Array.isArray(list.result.tools));

    for (const tool of list.result.tools) {
        assert.equal(tool.inputSchema.type, 'object');
        assert.equal(typeof tool.description, 'string');
    }
});

test('stdio smoke: default environment lists exactly the read tools', async () => {
    const messages = await smokeStdio({ CLOUDISP_ALLOW_WRITES: undefined });

    const list = messages.find((message) => message.id === 2);

    assert.deepEqual(list.result.tools.map((tool) => tool.name).sort(), [...READ_TOOL_NAMES].sort());
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
    assert.equal(messages[1].result.tools.length, READ_TOOL_NAMES.length + WRITE_TOOL_NAMES.length);
    assert.equal(messages[2].result.tools.length, READ_TOOL_NAMES.length + WRITE_TOOL_NAMES.length);
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

test('list_internet_profiles requests the full active list, not the default 20-row page', async () => {
    const urls = [];
    await dispatch('list_internet_profiles', {}, async (url) => {
        urls.push(String(url));
        return jsonResponse({ success: true, data: [], meta: { total: 0 } });
    }, {});

    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes('status=active'));
    assert.ok(urls[0].includes('per_page=100'));
});

// ─── v0.4.0: dates in Salta time ─────────────────────────────────────────────

test('toDisplayTime converts ISO instants of any zone to America/Argentina/Salta (-03:00)', () => {
    const cases = {
        '2026-10-14T13:00:00+00:00': '2026-10-14T10:00:00-03:00',
        '2026-10-14T13:00:00Z': '2026-10-14T10:00:00-03:00',
        '2026-10-14T13:00:00.123456+00:00': '2026-10-14T10:00:00-03:00',
        '2026-10-14T13:00:00+0000': '2026-10-14T10:00:00-03:00',
        '2026-10-14T13:00:00+00': '2026-10-14T10:00:00-03:00',
        '2026-10-14T01:30:00+02:00': '2026-10-13T20:30:00-03:00',
        '2026-10-14T10:00:00-03:00': '2026-10-14T10:00:00-03:00',
        '2026-10-14T03:00:00Z': '2026-10-14T00:00:00-03:00',
        '2027-01-01T02:59:59Z': '2026-12-31T23:59:59-03:00',
        '2026-10-14T10:00Z': '2026-10-14T07:00:00-03:00',
    };

    for (const [input, expected] of Object.entries(cases)) {
        assert.equal(toDisplayTime(input), expected, input);
    }
});

test('toDisplayTime reads YYYY-MM-DD HH:MM:SS without a zone as UTC', () => {
    assert.equal(toDisplayTime('2026-10-14 13:05:09'), '2026-10-14T10:05:09-03:00');
    assert.equal(toDisplayTime('2026-10-14 02:00:00'), '2026-10-13T23:00:00-03:00');
    assert.equal(toDisplayTime('2026-10-14 13:05:09.250000'), '2026-10-14T10:05:09-03:00');
});

test('toDisplayTime leaves everything that is not a date untouched', () => {
    const untouched = [
        '2026-10-14', '12:00:00', '2026-10-14T10:00:00', 'ONU 2026-10-14 13:00:00', '2026-10-14 13:00:00 UTC',
        '2026-13-45T00:00:00Z', '2026-02-31T00:00:00Z', '2026-02-31 00:00:00', '2026-10-14 25:00:00',
        'v1.2.3', 'ZTEG12345678', 'b464151bde68', '', 'null', 42, null, true, undefined, { at: '2026-10-14 13:00:00' },
    ];

    for (const value of untouched) {
        assert.equal(toDisplayTime(value), value, String(value));
    }
});

test('dispatch converts every date string of a payload, nested ones included, and nothing else', async () => {
    const task = taskProjection(9, 'succeeded', {
        sessions: [{ since: '2026-10-14 13:00:00', user: 'juan 2026-10-14 13:00:00', serial: 'ZTEG12345678' }],
        day: '2026-10-14',
    });
    const { result } = await run('get_task', { task_run_id: 9 }, {
        'GET /tasks/9': jsonResponse({ ...task, requested_at: '2026-10-14T13:00:00+00:00', finished_at: '2026-10-14T13:00:05Z' }),
    });

    assert.equal(result.requested_at, '2026-10-14T10:00:00-03:00');
    assert.equal(result.finished_at, '2026-10-14T10:00:05-03:00');
    assert.deepEqual(result.result, {
        sessions: [{ since: '2026-10-14T10:00:00-03:00', user: 'juan 2026-10-14 13:00:00', serial: 'ZTEG12345678' }],
        day: '2026-10-14',
    });
});

// ─── v0.4.0: device_error ────────────────────────────────────────────────────

/**
 * Call one tool through an in-process stdio server (real clock, writes on) and decode its answer.
 *
 * @param {string} name Tool name.
 * @param {object} args Tool arguments.
 * @param {Record<string, object|Function>} routes Route table, see {@link mockApi}.
 * @return {Promise<{ isError: boolean, payload: object }>}
 */
async function callOverStdio(name, args, routes) {
    const input = new PassThrough();
    const output = new PassThrough();
    const written = [];

    output.on('data', (chunk) => written.push(chunk.toString('utf8')));
    startServer({
        input,
        output,
        env: { CLOUDISP_API_BASE: API_BASE, CLOUDISP_API_KEY: API_KEY, CLOUDISP_ALLOW_WRITES: '1' },
        fetchImpl: mockApi(routes).fetchImpl,
    });
    input.write(encodeLine({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { result } = decodeMessages(Buffer.from(written.join(''), 'utf8')).find((message) => message.id === 1);

    return { isError: result.isError, payload: JSON.parse(result.content[0].text) };
}

test('a succeeded task whose result carries an error is the device_error outcome, and not a tool error', async () => {
    const routes = { 'GET /tasks/5527': jsonResponse(taskProjection(5527, 'succeeded', { error: 'onu_offline', onu_state: 'offline' })) };
    const { result } = await run('get_task', { task_run_id: 5527 }, routes);

    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'device_error');
    assert.equal(result.error, 'onu_offline');
    assert.equal(result.task_run_id, 5527);
    assert.equal(result.details.onu_state, 'offline');
    assert.match(result.hint, /OT/);

    const stdio = await callOverStdio('get_task', { task_run_id: 5527 }, routes);

    assert.equal(stdio.isError, false);
    assert.equal(stdio.payload.outcome, 'device_error');
});

test('restart_observed false on a succeeded task is a device_error too, and a replay flag survives', async () => {
    const { result } = await run('reboot_onu', { ...WRITE_ARGS, subscriber_id: 42 }, {
        'POST /subscribers/42/onu/actions': accepted(9, { replayed: true }),
        'GET /tasks/9': jsonResponse(taskProjection(9, 'succeeded', { restart_observed: false })),
    });

    assert.equal(result.outcome, 'device_error');
    assert.equal(result.error, 'restart_not_observed');
    assert.equal(result.task_run_id, 9);
    assert.equal(result.replayed, true);
});

test('a succeeded task without an error, and a failed one, are not device_error', async () => {
    for (const result of [{ restart_observed: true, error: null }, { ssids: [] }, {}]) {
        const done = await run('get_task', { task_run_id: 3 }, { 'GET /tasks/3': jsonResponse(taskProjection(3, 'succeeded', result)) });

        assert.equal(done.result.success, true);
        assert.equal(done.result.outcome, undefined);
    }

    const failed = await run('get_task', { task_run_id: 3 }, { 'GET /tasks/3': jsonResponse(taskProjection(3, 'failed', { error: 'x' }, 'onu_offline')) });

    assert.equal(failed.result.outcome, 'task_failed');
});

// ─── v0.4.0: task budgets ────────────────────────────────────────────────────

test('reboot, sync, reprovision, swap and factory reset wait up to 110 s; every other task tool keeps the 40 s budget', async () => {
    const swap = { network_onu_id: 5, serial: 'ZTEG1', mac: 'b464151bde68' };
    const cases = [
        ['reboot_onu', {}, 'POST /subscribers/42/onu/actions', 110000],
        ['sync_onu', {}, 'POST /subscribers/42/onu/sync', 110000],
        ['reprovision_onu', {}, 'POST /subscribers/42/onu/provision', 110000],
        ['swap_onu', swap, 'POST /subscribers/42/onu/swap', 110000],
        ['factory_reset_onu', { confirm: 'factory_reset' }, 'POST /subscribers/42/onu/actions', 110000],
        ['set_onu_catv', { catv_state: 'enable' }, 'POST /subscribers/42/onu/actions', 40000],
        ['set_onu_admin_state', { admin_state: 'enable' }, 'POST /subscribers/42/onu/actions', 40000],
        ['optimize_wifi', { mode: 'preview' }, 'POST /subscribers/42/onu/actions', 40000],
        ['restore_wifi', {}, 'POST /subscribers/42/onu/actions', 40000],
        ['onu_read', { operation: 'onu.wan_read' }, 'POST /subscribers/42/onu/reads', 40000],
        ['onu_diagnose', {}, 'POST /subscribers/42/onu/diagnose', 40000],
    ];

    for (const [name, args, route, budget] of cases) {
        const clock = virtualClock();
        const { result } = await run(name, { ...WRITE_ARGS, subscriber_id: 42, ...args }, {
            [route]: accepted(9),
            'GET /tasks/9': jsonResponse(taskProjection(9, 'running')),
        }, clock);

        assert.deepEqual(result, { status: 'pending', task_run_id: 9 }, name);
        assert.equal(clock.elapsed, budget, name);
    }
});

test('get_task with wait_seconds polls until the task finishes, or answers pending when the time is up', async () => {
    const running = jsonResponse(taskProjection(9, 'running'));
    const waiting = virtualClock();
    const stuck = await run('get_task', { task_run_id: 9, wait_seconds: 30 }, { 'GET /tasks/9': running }, waiting);

    assert.deepEqual(stuck.result, { status: 'pending', task_run_id: 9 });
    assert.equal(waiting.elapsed, 30000);

    const finishing = virtualClock();
    const done = await run('get_task', { task_run_id: 9, wait_seconds: 110 }, {
        'GET /tasks/9': sequence(running, running, jsonResponse(taskProjection(9, 'succeeded', { ok: true }))),
    }, finishing);

    assert.equal(done.result.status, 'succeeded');
    assert.equal(finishing.elapsed, 4000);
    assert.equal(done.calls.length, 3);
});

test('get_task answers at once without wait_seconds (or with 0) and refuses a wait beyond 110 s without HTTP', async () => {
    for (const args of [{ task_run_id: 9 }, { task_run_id: 9, wait_seconds: 0 }]) {
        const clock = virtualClock();
        const { calls } = await run('get_task', args, { 'GET /tasks/9': jsonResponse(taskProjection(9, 'running')) }, clock);

        assert.equal(calls.length, 1);
        assert.equal(clock.elapsed, 0);
    }

    for (const wait_seconds of [111, -1, 1.5, 'later']) {
        const { result, calls } = await run('get_task', { task_run_id: 9, wait_seconds });

        assert.equal(result.outcome, 'validation_failed', String(wait_seconds));
        assert.equal(calls.length, 0);
    }
});

// ─── v0.4.0: new reads ───────────────────────────────────────────────────────

test('list_onus passes the model, firmware, platform and offline filters; network_snapshot passes platform_id', async () => {
    const ok = jsonResponse({ success: true, data: [], meta: { total: 0 } });
    const onus = await run('list_onus', { product_class: 'F670L', firmware: 'V9.0.11', platform_id: 3, offline_only: true, per_page: 1 }, { 'GET /network/onus': ok });

    assert.equal(onus.calls[0].query.get('product_class'), 'F670L');
    assert.equal(onus.calls[0].query.get('firmware'), 'V9.0.11');
    assert.equal(onus.calls[0].query.get('platform_id'), '3');
    assert.equal(onus.calls[0].query.get('offline_only'), '1');

    const plain = await run('list_onus', { offline_only: false }, { 'GET /network/onus': ok });

    assert.equal(plain.calls[0].query.has('offline_only'), false);

    const snapshot = await run('network_snapshot', { platform_id: 15 }, { 'GET /operations/snapshot': ok });

    assert.equal(snapshot.calls[0].query.get('platform_id'), '15');
    assert.equal((await run('network_snapshot', {}, { 'GET /operations/snapshot': ok })).calls[0].query.has('platform_id'), false);
});

test('list_onu_models, get_router, olt_poll_runs and list_eoc_masters map onto their endpoints', async () => {
    const ok = jsonResponse({ success: true, data: [] });
    const routes = {
        'GET /network/onu-models': ok, 'GET /network/routers/5': ok, 'GET /network/olts/6/poll-runs': ok, 'GET /network/eoc-masters': ok,
    };

    const models = await run('list_onu_models', { platform_id: 3 }, routes);
    const router = await run('get_router', { router_id: 5 }, routes);
    const polls = await run('olt_poll_runs', { olt_id: 6, limit: 5 }, routes);
    const masters = await run('list_eoc_masters', { platform_id: 15 }, routes);

    assert.deepEqual(sig(models.calls), ['GET /network/onu-models']);
    assert.equal(models.calls[0].query.get('platform_id'), '3');
    assert.deepEqual(sig(router.calls), ['GET /network/routers/5']);
    assert.deepEqual(sig(polls.calls), ['GET /network/olts/6/poll-runs']);
    assert.equal(polls.calls[0].query.get('limit'), '5');
    assert.deepEqual(sig(masters.calls), ['GET /network/eoc-masters']);
    assert.equal(masters.calls[0].query.get('platform_id'), '15');

    for (const [name, args] of [['get_router', {}], ['olt_poll_runs', {}]]) {
        const refused = await run(name, args);

        assert.equal(refused.result.outcome, 'validation_failed', name);
        assert.equal(refused.calls.length, 0);
    }
});

test('subscriber_usage resolves the subscriber and passes the window; a bad window is refused without HTTP', async () => {
    const routes = { 'GET /subscribers': ONE_SUBSCRIBER, 'GET /subscribers/42/usage': jsonResponse({ success: true, data: { download_bytes: 10 } }) };
    const { result, calls } = await run('subscriber_usage', { subscriber_query: 'Perez', window: '7d' }, routes);

    assert.deepEqual(sig(calls), ['GET /subscribers', 'GET /subscribers/42/usage']);
    assert.equal(calls[1].query.get('window'), '7d');
    assert.equal(result.data.download_bytes, 10);

    const defaulted = await run('subscriber_usage', { subscriber_id: 42 }, routes);

    assert.equal(defaulted.calls[0].query.has('window'), false);

    const refused = await run('subscriber_usage', { subscriber_id: 42, window: '1y' }, routes);

    assert.equal(refused.result.outcome, 'validation_failed');
    assert.equal(refused.calls.length, 0);
});

test('usage_ranking maps its filters onto the query string and caps limit at 50', async () => {
    const routes = { 'GET /network/usage/ranking': jsonResponse({ success: true, data: [], no_data: [] }) };
    const { calls } = await run('usage_ranking', {
        platform_id: 4, olt_id: 6, pon_slot: 0, pon_port: 3, window: '7d', order: 'asc', limit: 10,
    }, routes);

    assert.deepEqual(Object.fromEntries(calls[0].query), {
        platform_id: '4', olt_id: '6', pon_slot: '0', pon_port: '3', window: '7d', order: 'asc', limit: '10',
    });

    for (const args of [{ limit: 51 }, { window: '30d' }, { order: 'up' }]) {
        const refused = await run('usage_ranking', args, routes);

        assert.equal(refused.result.outcome, 'validation_failed', JSON.stringify(args));
        assert.equal(refused.calls.length, 0);
    }
});

test('device_tasks reads a device or a subscriber, never both and never neither', async () => {
    const ok = jsonResponse({ success: true, data: [] });
    const routes = { 'GET /network/devices/olt/6/tasks': ok, 'GET /subscribers/42/tasks': ok, 'GET /subscribers': ONE_SUBSCRIBER };

    const device = await run('device_tasks', { kind: 'olt', device_id: 6, limit: 20 }, routes);

    assert.deepEqual(sig(device.calls), ['GET /network/devices/olt/6/tasks']);
    assert.equal(device.calls[0].query.get('limit'), '20');

    const subscriber = await run('device_tasks', { subscriber_query: 'Perez' }, routes);

    assert.deepEqual(sig(subscriber.calls), ['GET /subscribers', 'GET /subscribers/42/tasks']);

    for (const args of [{}, { kind: 'olt', device_id: 6, subscriber_id: 42 }, { kind: 'switch', device_id: 6 }, { kind: 'olt' }, { subscriber_id: 42, limit: 51 }]) {
        const refused = await run('device_tasks', args, routes);

        assert.equal(refused.result.outcome, 'validation_failed', JSON.stringify(args));
        assert.equal(refused.calls.length, 0);
    }
});

test('live_traffic answers the first 200; while the API answers 202 it asks again every 2 s, up to 5 times', async () => {
    const sample = jsonResponse({
        success: true,
        data: { download_bps: 1200, upload_bps: 300, sampled_at: '2026-10-14T13:00:00+00:00', source: 'redis', task_run_id: 4 },
    });
    const clock = virtualClock();
    const started = await run('live_traffic', { subscriber_id: 42 }, {
        'POST /subscribers/42/live-traffic': sequence(accepted(4), accepted(4), sample),
    }, clock);

    assert.deepEqual(sig(started.calls), Array(3).fill('POST /subscribers/42/live-traffic'));
    assert.equal(clock.elapsed, 4000);
    assert.equal(started.result.data.download_bps, 1200);
    assert.equal(started.result.data.sampled_at, '2026-10-14T10:00:00-03:00');

    const stuckClock = virtualClock();
    const stuck = await run('live_traffic', { subscriber_id: 42 }, { 'POST /subscribers/42/live-traffic': accepted(4) }, stuckClock);

    assert.equal(stuck.calls.length, 5, 'no GET /tasks: the watch task never carries the sample');
    assert.equal(stuckClock.elapsed, 8000);
    assert.equal(stuck.result.status, 'pending');
    assert.equal(stuck.result.task_run_id, 4);

    const refused = await run('live_traffic', { subscriber_id: 42 }, {
        'POST /subscribers/42/live-traffic': errorResponse(422, { code: 'onu_not_linked', message: 'No ONU.' }),
    });

    assert.equal(refused.result.outcome, 'onu_not_linked');
    assert.equal(refused.calls.length, 1);
});

test('onu_read onu.wifi_password_check runs onu.wifi_read first and posts ssid_index with that read\'s task id', async () => {
    const { result, calls } = await run('onu_read', { subscriber_id: 42, operation: 'onu.wifi_password_check', parameters: { ssid_index: 1 } }, {
        'POST /subscribers/42/onu/reads': (call) => (call.body.operation === 'onu.wifi_read' ? accepted(7) : accepted(8)),
        'GET /tasks/7': jsonResponse(taskProjection(7, 'succeeded', { ssids: [{ index: 1 }] })),
        'GET /tasks/8': jsonResponse(taskProjection(8, 'succeeded', { match: true })),
    });

    assert.deepEqual(sig(calls), ['POST /subscribers/42/onu/reads', 'GET /tasks/7', 'POST /subscribers/42/onu/reads', 'GET /tasks/8']);
    assert.deepEqual(calls[0].body, { operation: 'onu.wifi_read', parameters: {} });
    assert.deepEqual(calls[2].body, { operation: 'onu.wifi_password_check', parameters: { ssid_index: 1, based_on_task_run_id: 7 } });
    assert.equal(result.result.match, true);

    for (const parameters of [undefined, {}, { ssid_index: 9 }, { ssid_index: 0 }]) {
        const refused = await run('onu_read', { subscriber_id: 42, operation: 'onu.wifi_password_check', parameters });

        assert.equal(refused.result.outcome, 'validation_failed', JSON.stringify(parameters));
        assert.equal(refused.calls.length, 0);
    }

    const unreadable = await run('onu_read', { subscriber_id: 42, operation: 'onu.wifi_password_check', parameters: { ssid_index: 1 } }, {
        'POST /subscribers/42/onu/reads': errorResponse(422, { code: 'onu_not_linked', message: 'No ONU.' }),
    });

    assert.equal(unreadable.result.outcome, 'onu_not_linked');
    assert.equal(unreadable.calls.length, 1, 'no password check without a WiFi read');
});

// ─── v0.4.0: new writes ──────────────────────────────────────────────────────

const OPTIMIZE_PLAN = [{ control: 'channel', band: '2.4', from: 6, to: 11 }];

test('the new ONU writes post their operation or endpoint with the idempotency key and the operator headers, then await the task', async () => {
    const cases = [
        ['set_onu_admin_state', { admin_state: 'disable' }, '/onu/actions', { operation: 'olt.onu_admin_state', parameters: { admin_state: 'disable' } }],
        ['factory_reset_onu', { confirm: 'factory_reset' }, '/onu/actions', { operation: 'onu.factory_reset', parameters: { confirm: 'factory_reset' } }],
        ['restore_wifi', {}, '/onu/actions', { operation: 'onu.wifi_restore', parameters: {} }],
        ['optimize_wifi', { mode: 'preview' }, '/onu/actions', { operation: 'onu.wifi_optimize', parameters: { mode: 'preview' } }],
        ['optimize_wifi', { mode: 'apply', plan: OPTIMIZE_PLAN }, '/onu/actions', { operation: 'onu.wifi_optimize', parameters: { mode: 'apply', plan: OPTIMIZE_PLAN } }],
        ['reprovision_onu', {}, '/onu/provision', {}],
        [
            'swap_onu',
            { network_onu_id: 5, serial: 'ZTEG1', mac: 'b464151bde68', ssid_24: 'Casa', wifi_password: 'S3cr3t-pass', keep_password: false },
            '/onu/swap',
            { network_onu_id: 5, serial: 'ZTEG1', mac: 'b464151bde68', ssid_24: 'Casa', wifi_password: 'S3cr3t-pass', keep_password: false },
        ],
    ];

    for (const [name, args, suffix, body] of cases) {
        const { result, calls } = await run(name, { ...WRITE_ARGS, subscriber_id: 42, ...args }, {
            [`POST /subscribers/42${suffix}`]: accepted(9),
            'GET /tasks/9': jsonResponse(taskProjection(9, 'succeeded', { done: true })),
        });

        assert.deepEqual(sig(calls), [`POST /subscribers/42${suffix}`, 'GET /tasks/9'], name);
        assert.deepEqual(calls[0].body, body, name);
        assert.equal(calls[0].headers['Idempotency-Key'], 'op-1', name);
        assert.equal(calls[0].headers['X-CloudISP-Requested-By'], 'Marcos Rivadeo', name);
        assert.equal(result.task_run_id, 9, name);
    }
});

test('the new writes resolve a subscriber_query to exactly one subscriber before any POST', async () => {
    const ambiguous = await run('reprovision_onu', { ...WRITE_ARGS, subscriber_query: 'Perez' }, {
        'GET /subscribers': jsonResponse({ success: true, data: [{ id: 1 }, { id: 2 }], meta: { total: 2 } }),
    });

    assert.equal(ambiguous.result.outcome, 'ambiguous_subscriber');
    assert.deepEqual(sig(ambiguous.calls), ['GET /subscribers']);

    const resolved = await run('kick_pppoe', { ...WRITE_ARGS, subscriber_query: 'Perez' }, {
        'GET /subscribers': ONE_SUBSCRIBER,
        'POST /subscribers/42/pppoe/kick': jsonResponse({ success: true, data: { outcome: 'disconnected' } }),
    });

    assert.deepEqual(sig(resolved.calls), ['GET /subscribers', 'POST /subscribers/42/pppoe/kick']);
});

test('the new writes refuse invalid arguments without any HTTP call', async () => {
    const refusals = [
        ['set_onu_admin_state', {}],
        ['set_onu_admin_state', { admin_state: 'reboot' }],
        ['factory_reset_onu', {}],
        ['factory_reset_onu', { confirm: 'yes' }],
        ['optimize_wifi', {}],
        ['optimize_wifi', { mode: 'now' }],
        ['optimize_wifi', { mode: 'apply' }],
        ['optimize_wifi', { mode: 'apply', plan: [] }],
        ['optimize_wifi', { mode: 'apply', plan: ['channel'] }],
        ['optimize_wifi', { mode: 'preview', plan: OPTIMIZE_PLAN }],
        ['locate_new_onu', {}],
        ['locate_new_onu', { mac: 'b464151bde' }],
        ['swap_onu', { network_onu_id: 5, serial: 'ZTEG1', mac: 'not a mac' }],
        ['swap_onu', { serial: 'ZTEG1', mac: 'b464151bde68' }],
        ['swap_onu', { network_onu_id: 5, mac: 'b464151bde68' }],
    ];

    for (const [name, args] of refusals) {
        const { result, calls } = await run(name, { ...WRITE_ARGS, subscriber_id: 42, ...args });

        assert.equal(result.outcome, 'validation_failed', `${name} ${JSON.stringify(args)}`);
        assert.equal(calls.length, 0, name);
    }
});

test('kick_pppoe answers the synchronous result; refusals are outcomes, not tool errors', async () => {
    const done = await run('kick_pppoe', { ...WRITE_ARGS, subscriber_id: 42 }, {
        'POST /subscribers/42/pppoe/kick': jsonResponse({ success: true, data: { outcome: 'disconnected' } }),
    });

    assert.deepEqual(sig(done.calls), ['POST /subscribers/42/pppoe/kick']);
    assert.deepEqual(done.calls[0].body, {});
    assert.equal(done.calls[0].headers['Idempotency-Key'], 'op-1');
    assert.equal(done.result.data.outcome, 'disconnected');

    for (const [status, code] of [[409, 'no_active_session'], [422, 'kick_unavailable']]) {
        const refused = await run('kick_pppoe', { ...WRITE_ARGS, subscriber_id: 42 }, {
            'POST /subscribers/42/pppoe/kick': errorResponse(status, { code, message: 'No.' }),
        });

        assert.equal(refused.result.ok, false);
        assert.equal(refused.result.outcome, code);
    }
});

test('locate_new_onu awaits the task of every OLT and merges their matches with the OLT', async () => {
    const { result, calls } = await run('locate_new_onu', { ...WRITE_ARGS, subscriber_id: 42, mac: 'B4:64:15:1B:DE:68' }, {
        'POST /subscribers/42/onu/swap/locate': jsonResponse({
            success: true,
            data: {
                tasks: [
                    { olt_id: 6, olt_name: '300 Viviendas', task_run_id: 11, request_id: 'r11' },
                    { olt_id: 8, olt_name: 'Santa Rita', task_run_id: 12, request_id: 'r12' },
                ],
                errors: [{ olt_id: 9, olt_name: 'Otra', error: 'olt_unreachable' }],
            },
        }, 202),
        'GET /tasks/11': jsonResponse(taskProjection(11, 'succeeded', {
            matches: [{ network_onu_id: 77, serial: 'ZTEG1B1B1B1B', pon_slot: 0, pon_port: 3, onu_index: 12, model: 'F670L', state: 'online', linked_client_id: null }],
        })),
        'GET /tasks/12': jsonResponse(taskProjection(12, 'failed', {}, 'olt_rejected')),
    });

    assert.deepEqual(calls[0].body, { mac: 'B4:64:15:1B:DE:68' });
    assert.equal(calls[0].headers['Idempotency-Key'], 'op-1');
    assert.equal(result.success, true);
    assert.equal(result.matches.length, 1);
    assert.deepEqual(
        { olt_id: result.matches[0].olt_id, olt_name: result.matches[0].olt_name, network_onu_id: result.matches[0].network_onu_id, serial: result.matches[0].serial },
        { olt_id: 6, olt_name: '300 Viviendas', network_onu_id: 77, serial: 'ZTEG1B1B1B1B' },
    );
    assert.deepEqual(result.olts.map((olt) => [olt.olt_id, olt.status, olt.error_code]), [[6, 'succeeded', null], [8, 'failed', 'olt_rejected']]);
    assert.deepEqual(result.errors, [{ olt_id: 9, olt_name: 'Otra', error: 'olt_unreachable' }]);

    const refused = await run('locate_new_onu', { ...WRITE_ARGS, subscriber_id: 42, mac: 'b464151bde68' }, {
        'POST /subscribers/42/onu/swap/locate': errorResponse(422, { code: 'invalid_mac', message: 'No es una MAC válida.' }),
    });

    assert.equal(refused.result.outcome, 'invalid_mac');
});

test('swap_onu refusals from the API are outcomes', async () => {
    for (const code of ['onu_serial_mismatch', 'onu_mac_mismatch', 'onu_not_found']) {
        const { result } = await run('swap_onu', { ...WRITE_ARGS, subscriber_id: 42, network_onu_id: 5, serial: 'Z', mac: 'b464151bde68' }, {
            'POST /subscribers/42/onu/swap': errorResponse(409, { code, message: 'No.' }),
        });

        assert.equal(result.outcome, code);
    }
});

test('wifi_password never reaches the model, even when the API echoes it', async () => {
    const { payload } = await callOverStdio('get_task', { task_run_id: 9 }, {
        'GET /tasks/9': jsonResponse(taskProjection(9, 'succeeded', { wifi_password: 'S3cr3t-wifi', name: 'Casa' })),
    });

    assert.equal(payload.result.name, 'Casa');
    assert.equal(JSON.stringify(payload).includes('S3cr3t'), false);
});

// ─── v0.5.0: report files ────────────────────────────────────────────────────

/**
 * Build a `fetch` double response that carries a file.
 *
 * @param {Buffer} bytes File content.
 * @param {string} contentType Content-Type of the answer.
 * @return {object}
 */
function fileResponse(bytes, contentType) {
    return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        json: async () => { throw new Error('not json'); },
    };
}

/**
 * Dispatch a tool with writes on and a fresh artifact directory.
 *
 * @param {string} name Tool name.
 * @param {object} args Tool arguments.
 * @param {Record<string, object|Function>} [routes] Route table.
 * @return {Promise<{ result: object, calls: Array<object>, dir: string }>}
 */
async function runWithArtifacts(name, args, routes = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudisp-artifacts-'));
    const api = mockApi(routes);
    const result = await dispatch(name, args, api.fetchImpl, { ...WRITES_ON, CLOUDISP_ARTIFACT_DIR: dir }, virtualClock());

    return { result, calls: api.calls, dir };
}

test('export_report saves the PDF in the artifact directory and answers its MEDIA line', async () => {
    const pdf = Buffer.from('%PDF-1.7 fake');
    const { result, calls, dir } = await runWithArtifacts(
        'export_report',
        { key: 'workorders', format: 'pdf', from: '2026-10-01', to: '2026-10-15', platform_id: 2, _operator: OPERATOR },
        { 'GET /reports/workorders': fileResponse(pdf, 'application/pdf') },
    );

    assert.equal(result.ok, true);
    assert.equal(path.dirname(result.path), dir);
    assert.match(path.basename(result.path), /^reporte-workorders-\d{14}\.pdf$/);
    assert.equal(result.media, `MEDIA:${result.path}`);
    assert.equal(result.bytes, pdf.length);
    assert.deepEqual(fs.readFileSync(result.path), pdf);
    assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
    assert.equal(calls[0].query.get('format'), 'pdf');
    assert.equal(calls[0].query.get('filter_period'), '2026-10-01,2026-10-15');
    assert.equal(calls[0].query.has('from'), false);
    assert.equal(calls[0].query.has('to'), false);
    assert.equal(calls[0].query.get('platform_id'), '2');
    assert.equal(calls[0].headers['X-CloudISP-Tool'], 'export_report');
    assert.equal(calls[0].headers['X-CloudISP-Operator-Id'], 'telegram:941533777');
});

test('export_report also saves a CSV, and refuses a bad key, format or date before any HTTP call', async () => {
    const csv = await runWithArtifacts('export_report', { key: 'alerts', format: 'csv' }, {
        'GET /reports/alerts': fileResponse(Buffer.from('a;b\n1;2\n'), 'text/csv; charset=UTF-8'),
    });

    assert.match(path.basename(csv.result.path), /^reporte-alerts-\d{14}\.csv$/);

    for (const args of [{ key: '../x', format: 'pdf' }, { key: 'alerts', format: 'xlsx' }, { key: 'alerts' }, { key: 'alerts', format: 'pdf', from: '15/10/2026' }]) {
        const { result, calls } = await runWithArtifacts('export_report', args);

        assert.equal(result.outcome, 'validation_failed', JSON.stringify(args));
        assert.equal(calls.length, 0);
    }
});

test('export_report answers API refusals as outcomes and a wrong content type as an error', async () => {
    const refused = await runWithArtifacts('export_report', { key: 'alerts', format: 'pdf' }, {
        'GET /reports/alerts': errorResponse(422, { code: 'validation_failed', message: 'format must be pdf or csv.' }),
    });

    assert.equal(refused.result.outcome, 'validation_failed');
    assert.deepEqual(fs.readdirSync(refused.dir), []);

    const html = await runWithArtifacts('export_report', { key: 'alerts', format: 'pdf' }, {
        'GET /reports/alerts': fileResponse(Buffer.from('<html>'), 'text/html'),
    });

    assert.equal(html.result.outcome, 'unexpected_response');

    const json = await runWithArtifacts('export_report', { key: 'alerts', format: 'pdf' }, {
        'GET /reports/alerts': { ...jsonResponse({ success: true, data: { rows: [] } }), headers: { get: () => 'application/json' } },
    });

    assert.equal(json.result.outcome, 'unexpected_response');
});

test('every artifact write first deletes the files older than 24 hours', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudisp-artifacts-'));
    const stale = path.join(dir, 'viejo.pdf');
    const fresh = path.join(dir, 'reciente.pdf');

    fs.writeFileSync(stale, 'x');
    fs.writeFileSync(fresh, 'x');
    fs.utimesSync(stale, new Date(Date.now() - 25 * 3600 * 1000), new Date(Date.now() - 25 * 3600 * 1000));

    const api = mockApi({});
    const result = await dispatch('build_report', { title: 'T', sections: [{ heading: 'H' }] }, api.fetchImpl, { ...WRITES_ON, CLOUDISP_ARTIFACT_DIR: dir }, virtualClock());

    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
});

test('the artifact directory is created with mode 700 when it does not exist', async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cloudisp-artifacts-')), 'nested', 'out');
    const result = await dispatch('build_report', { title: 'T', sections: [{ heading: 'H' }] }, mockApi({}).fetchImpl, { ...WRITES_ON, CLOUDISP_ARTIFACT_DIR: dir }, virtualClock());

    assert.equal(result.ok, true);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('build_report writes a self-contained HTML file with the KPIs, the table and the SVG charts, and makes no API call', async () => {
    const { result, calls } = await runWithArtifacts('build_report', {
        title: 'Consumo de la PON 8 · 300 Viviendas',
        subtitle: 'Octubre 2026',
        sections: [
            {
                heading: 'Resumen',
                text: 'Primera línea.\n\nSegundo párrafo con <b>etiquetas</b> & símbolos.',
                kpis: [{ label: 'Abonados', value: 41 }, { label: 'Tráfico', value: null }],
            },
            {
                heading: 'Consumo diario',
                chart: { type: 'bar', categories: ['Lun', 'Mar', 'Mié'], series: [{ name: 'GB', data: [10, null, 30] }], unit: 'GB' },
                table: { columns: ['Abonado', 'GB'], rows: [['#2861', 12.5], ['#4979', null]] },
            },
            { heading: 'Evolución', chart: { type: 'line', categories: ['a', 'b', 'c', 'd'], series: [{ name: 'Mbps', data: [1, 2, null, 4] }] } },
            { heading: 'Reparto', chart: { type: 'donut', categories: ['Pinares', 'Cerrillos'], series: [{ name: 'ONU', data: [30, 70] }] } },
        ],
    });

    assert.deepEqual(calls, []);
    assert.equal(result.ok, true);
    assert.match(path.basename(result.path), /^informe-consumo-de-la-pon-8-300-viviendas-\d{14}\.html$/);
    assert.equal(result.media, `MEDIA:${result.path}`);

    const html = fs.readFileSync(result.path, 'utf8');

    assert.equal(result.bytes, Buffer.byteLength(html));
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<html lang="es">/);
    assert.match(html, /src="data:image\/png;base64,/);
    assert.equal((html.match(/<svg /g) ?? []).length, 3);
    assert.match(html, /Generado por el Asistente CloudISP · \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
    assert.match(html, /@media print/);
    assert.match(html, /&lt;b&gt;etiquetas&lt;\/b&gt; &amp; símbolos/, 'text is escaped');
    assert.equal(html.includes('<b>etiquetas</b>'), false);
    assert.match(html, /<b class="nd">no disponible<\/b>/, 'a null KPI is "no disponible", never 0');
    assert.match(html, /<td class="nd">no disponible<\/td>/, 'a null table cell is "no disponible"');
    assert.match(html, /Sin dato \(no disponible\): GB \(Mar\)\./, 'a null chart value is captioned');
    assert.equal(/<script|https?:\/\//.test(html.replaceAll('http://www.w3.org/2000/svg', '')), false, 'no scripts, no external requests');
});

test('build_report refuses malformed reports before writing anything', async () => {
    const section = (extra) => ({ heading: 'H', ...extra });
    const cases = [
        {},
        { title: 'T' },
        { title: 'T', sections: [] },
        { title: 'T', sections: Array.from({ length: 21 }, () => section()) },
        { title: '  ', sections: [section()] },
        { title: 'T', sections: [{ text: 'sin encabezado' }] },
        { title: 'T', sections: [section({ table: { columns: ['a', 'b'], rows: [['solo uno']] } })] },
        { title: 'T', sections: [section({ table: { columns: ['a'], rows: Array.from({ length: 201 }, () => ['x']) } })] },
        { title: 'T', sections: [section({ chart: { type: 'pie', categories: ['a'], series: [{ name: 's', data: [1] }] } })] },
        { title: 'T', sections: [section({ chart: { type: 'bar', categories: ['a', 'b'], series: [{ name: 's', data: [1] }] } })] },
        { title: 'T', sections: [section({ chart: { type: 'bar', categories: ['a'], series: [{ name: 's', data: ['1'] }] } })] },
        { title: 'T', sections: [section({ chart: { type: 'donut', categories: ['a', 'b'], series: [{ name: 's', data: [1, 2] }, { name: 't', data: [1, 2] }] } })] },
        { title: 'T', sections: [section({ chart: { type: 'donut', categories: ['a'], series: [{ name: 's', data: [-1] }] } })] },
    ];

    for (const args of cases) {
        const { result, dir } = await runWithArtifacts('build_report', args);

        assert.equal(result.outcome, 'validation_failed', JSON.stringify(args).slice(0, 120));
        assert.deepEqual(fs.readdirSync(dir), []);
    }
});

test('the report tools are read-only and tell the agent to include the media line', async () => {
    const tools = await listedTools({ CLOUDISP_ALLOW_WRITES: undefined });

    for (const name of ['export_report', 'build_report']) {
        const tool = tools.find((candidate) => candidate.name === name);

        assert.equal(tool.annotations.readOnlyHint, true, name);
        assert.match(tool.description, /Para enviarlo, incluí la línea `media` tal cual en tu respuesta\./, name);
    }
});

// ─── v0.5.0: guide ───────────────────────────────────────────────────────────

const PLUGIN_DIR = new URL('./hermes-plugin/cloudisp/', import.meta.url);

test('every tool carries a guide entry in one of the fixed categories, and the 55 tools are all there', () => {
    const catalog = guideCatalog();

    assert.equal(catalog.length, 55);

    for (const tool of catalog) {
        assert.ok(tool.guide, `${tool.name} has no guide entry`);
        assert.ok(['Abonados', 'ONU y WiFi', 'Red y equipos (sólo lectura)', 'Consumo y tráfico', 'Órdenes de trabajo', 'Informes y gráficos', 'Conocimiento'].includes(tool.guide.category), tool.name);
        assert.ok(tool.guide.label_es && tool.guide.example_es, tool.name);
    }
});

test('guia.md and write_tools.json are up to date with the tool catalogue (run npm run guide)', () => {
    const catalog = guideCatalog();

    assert.equal(fs.readFileSync(new URL('guia.md', PLUGIN_DIR), 'utf8'), renderGuide(catalog));
    assert.equal(fs.readFileSync(new URL('write_tools.json', PLUGIN_DIR), 'utf8'), renderWriteTools(catalog));
});

test('the guide names no internal tool, marks every write with the pencil and closes with the confirmation rule', () => {
    const guide = renderGuide(guideCatalog());

    for (const { name } of guideCatalog()) {
        assert.equal(guide.includes(name), false, `${name} must not appear in the guide`);
    }

    assert.equal(/hermes|omh|deepseek|kimi|opencode/i.test(guide), false);
    assert.ok(guide.includes('**Reiniciar la ONU** ✍️'));
    assert.ok(!guide.includes('**Buscar un abonado** ✍️'));
    assert.ok(guide.endsWith('Las acciones con ✍️ siempre piden tu confirmación. Usá /new para empezar una conversación nueva.\n'));
    assert.deepEqual(guide.match(/^\*\*[^*]+\*\*$/gm).slice(1), [
        '**Abonados**', '**ONU y WiFi**', '**Red y equipos (sólo lectura)**', '**Consumo y tráfico**', '**Órdenes de trabajo**', '**Informes y gráficos**', '**Conocimiento**',
    ]);
});

test('write_tools.json lists exactly the tools that are not read-only, each with its approval label', () => {
    const writes = JSON.parse(fs.readFileSync(new URL('write_tools.json', PLUGIN_DIR), 'utf8'));

    assert.deepEqual(Object.keys(writes).sort(), [...WRITE_TOOL_NAMES].sort());

    for (const label of Object.values(writes)) {
        assert.equal(typeof label, 'string');
        assert.notEqual(label, '');
    }
});

test('no tool description, schema text or guide entry names a tenant: ids come from cloudisp_context', async () => {
    const tools = await listedTools({ CLOUDISP_ALLOW_WRITES: '1' });
    const texts = [
        ...tools.map((tool) => JSON.stringify(tool)),
        ...guideCatalog().map((tool) => JSON.stringify(tool.guide)),
        renderGuide(guideCatalog()),
    ];

    for (const text of texts) {
        assert.equal(/NVS|Pinares|Cerrillos|Merced|Viviendas|San Agust|InterService|Longarela|Frontera/i.test(text), false, text.slice(0, 80));
    }

    assert.match(tools.find((tool) => tool.name === 'list_onus').inputSchema.properties.platform_id.description, /cloudisp_context/);
});

test('the SOUL template: a denial is final for the turn, off-topic requests are refused, and no runtime brand is named', () => {
    const soul = fs.readFileSync(new URL('./deploy/hermes-tenant/SOUL.md.tmpl', import.meta.url), 'utf8');

    assert.match(soul, /Un "no" es definitivo para ese turno/);
    assert.match(soul, /NUNCA reintentes esa escritura/);
    assert.match(soul, /Sólo un mensaje nuevo y explícito del operador/);
    assert.match(soul, /Sólo puedo ayudarte con la operación de CloudISP\. Escribí \/guia/);
    assert.match(soul, /poemas, cuentos, código/);
    assert.match(soul, /Soy el {BOT_NAME} de {TENANT_NAME}; estoy para ayudarte con la operación de tu red\. ¿En qué te ayudo\?/);
    assert.equal(/hermes|nous|omh|opencode|deepseek|kimi/i.test(soul), false);
    assert.equal(/requested_by/.test(soul), false);

    const numbers = [...soul.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));

    for (let index = 1; index < numbers.length; index += 1) {
        assert.ok(numbers[index] === numbers[index - 1] + 1 || numbers[index] === 1, `rule numbering around ${numbers[index]}`);
    }
});

test('the guide markup survives the Telegram adapter: only **bold** pairs, no underscores, examples between « »', () => {
    const guide = renderGuide(guideCatalog());
    // `{bot_name}` and `{tenant_name}` are the only underscores allowed: the plugin replaces them before sending.
    const sent = guide.replace('{bot_name}', 'Asistente CloudISP').replace('{tenant_name}', 'NVS InterService');

    assert.equal(sent.includes('_'), false, 'the adapter escapes underscores: an italic written with them shows raw');
    assert.equal(sent.replace(/\*\*[^*\n]+\*\*/g, '').includes('*'), false, 'every asterisk belongs to a **bold** pair');

    const examples = sent.split('\n').filter((line) => line.startsWith('• '));

    assert.equal(examples.length, guideCatalog().filter((tool) => !tool.guide.hidden).length);

    for (const line of examples) {
        assert.match(line, /^• \*\*[^*]+\*\*( ✍️)? — ejemplo: «[^«»]+»$/, line);
    }
});

// ─── v0.5.2: API contract fixes (audit 2026-10-16: M1, M5, M7, M9, M12-M15, M18) ──

/**
 * @param {string} name Tool name.
 * @return {{ description: string, inputSchema: object }} The tool as `tools/list` shows it (writes on).
 */
function toolSchema(name) {
    return listTools(WRITES_ON).find((tool) => tool.name === name);
}

/**
 * Run a tool against an empty route table: it must answer `validation_failed` and never reach `fetch`.
 *
 * @param {string} name Tool name.
 * @param {object} args Tool arguments.
 * @return {Promise<void>}
 */
async function assertRefused(name, args) {
    const { result, calls } = await run(name, args);

    assert.equal(result.outcome, 'validation_failed', `${name} ${JSON.stringify(args)}`);
    assert.equal(calls.length, 0, `${name} ${JSON.stringify(args)} reached the API`);
}

test('M1: olt_read does not offer olt.unprovisioned_onus_read (the API refuses it) and refuses it before any HTTP call', async () => {
    const tool = toolSchema('olt_read');

    assert.deepEqual(tool.inputSchema.properties.operation.enum, ['olt.health_check', 'olt.system_info_read', 'olt.mac_table_read', 'olt.poll']);
    assert.equal(tool.description.includes('unprovisioned'), false);

    await assertRefused('olt_read', { olt_id: 6, operation: 'olt.unprovisioned_onus_read' });
});

test('M9: device_metrics checks window, resolution and metric ids before any HTTP call', async () => {
    const { description, inputSchema } = toolSchema('device_metrics');

    assert.deepEqual(inputSchema.properties.window.enum, ['15m', '1h', '6h', '24h', '7d', '30d']);
    assert.deepEqual(inputSchema.properties.resolution.enum, ['auto', 'raw', 'trend_1h']);
    assert.equal(inputSchema.properties.metric_ids.maxItems, 8);
    assert.match(description, /must be taken from the catalogue: call without metric_ids first/);

    const base = { kind: 'routeros', device_id: 3 };
    const nine = Array.from({ length: 9 }, (_, index) => String(index).repeat(64));

    for (const extra of [
        { metric_ids: ['cpu'] },
        { metric_ids: [METRIC_A], window: '5m' },
        { metric_ids: [METRIC_A], resolution: '5m' },
        { metric_ids: [METRIC_A.toUpperCase()] },
        { metric_ids: ['a'.repeat(63)] },
        { metric_ids: [METRIC_A, 7] },
        { metric_ids: nine },
        { metric_ids: METRIC_A },
    ]) {
        await assertRefused('device_metrics', { ...base, ...extra });
    }

    const eight = nine.slice(0, 8);
    const { calls } = await run('device_metrics', { ...base, metric_ids: eight }, {
        'GET /network/devices/routeros/3/metrics/series': jsonResponse({ success: true, data: [] }),
    });

    assert.deepEqual(calls[0].query.getAll('metric_id[]'), eight);
    assert.equal(calls[0].query.has('window'), false, 'the API default (24h) applies');
    assert.equal(calls[0].query.has('resolution'), false, 'the API default (auto) applies');
});

test('M15: device_metrics passes the catalogue filters and paging through, and checks their bounds', async () => {
    const routes = { 'GET /network/devices/olt/6/metrics/catalog': jsonResponse({ success: true, data: [] }) };
    const { calls } = await run('device_metrics', {
        kind: 'olt', device_id: 6, search: 'rx power', family_id: METRIC_A, template_id: METRIC_B, state: 'active', selected: true, cursor: 'c-1.2:3', limit: 50,
    }, routes);

    assert.deepEqual(sig(calls), ['GET /network/devices/olt/6/metrics/catalog']);
    assert.deepEqual(Object.fromEntries(calls[0].query), {
        search: 'rx power', family_id: METRIC_A, template_id: METRIC_B, state: 'active', selected: '1', cursor: 'c-1.2:3', limit: '50',
    });

    const unselected = await run('device_metrics', { kind: 'olt', device_id: 6, selected: false, limit: 500 }, routes);

    assert.deepEqual(Object.fromEntries(unselected.calls[0].query), { selected: '0', limit: '500' });

    for (const extra of [{ limit: 0 }, { limit: 501 }, { family_id: 'x' }, { template_id: METRIC_A.toUpperCase() }, { selected: 'maybe' }]) {
        await assertRefused('device_metrics', { kind: 'olt', device_id: 6, ...extra });
    }

    const series = await run('device_metrics', { kind: 'olt', device_id: 6, metric_ids: [METRIC_A], search: 'rx' }, {
        'GET /network/devices/olt/6/metrics/series': jsonResponse({ success: true, data: [] }),
    });

    assert.equal(series.calls[0].query.has('search'), false, 'catalogue filters never travel with a series call');
});

test('M12: export_report sends the period as filter_period and passes the free filters like run_report', async () => {
    const csv = { 'GET /reports/workorders': fileResponse(Buffer.from('a;b\n'), 'text/csv') };
    const { calls } = await runWithArtifacts('export_report', {
        key: 'workorders',
        format: 'csv',
        from: '2026-10-01',
        to: '2026-10-15',
        platform_id: 2,
        filters: { filter_granularity: 'week', filter_status: 'open', format: 'pdf', filter_period: '2020-01-01,2020-01-02' },
    }, csv);

    assert.deepEqual(Object.fromEntries(calls[0].query), {
        filter_granularity: 'week', filter_status: 'open', format: 'csv', platform_id: '2', filter_period: '2026-10-01,2026-10-15',
    }, 'from/to win over a filter_period filter, and no filter can change the format');

    const free = await runWithArtifacts('export_report', {
        key: 'workorders', format: 'csv', filters: { filter_period: '2026-09-01,2026-09-30' },
    }, csv);

    assert.deepEqual(Object.fromEntries(free.calls[0].query), { format: 'csv', filter_period: '2026-09-01,2026-09-30' });

    for (const args of [{ from: '2026-10-01' }, { to: '2026-10-15' }]) {
        const refused = await runWithArtifacts('export_report', { key: 'workorders', format: 'csv', ...args });

        assert.equal(refused.result.outcome, 'validation_failed', JSON.stringify(args));
        assert.equal(refused.calls.length, 0);
    }

    assert.equal(toolSchema('export_report').inputSchema.properties.filters.type, 'object');
});

test('M13: disconnect_subscriber keeps the work order external_ref within 100 characters for a longer idempotency key', async () => {
    const routes = {
        'POST /subscribers/42/disconnect': jsonResponse({ success: true, data: { id: 42, lifecycle_status: 'disconnected' } }),
        'POST /work-orders': jsonResponse({ success: true, data: { id: 77 } }),
    };
    const disconnect = (key) => run('disconnect_subscriber', { ...WRITE_ARGS, idempotency_key: key, subscriber_id: 42, open_work_order: true }, routes);

    const longKey = 'k'.repeat(128);
    const first = await disconnect(longKey);
    const ref = first.calls[1].body.external_ref;

    assert.equal(first.calls[0].headers['Idempotency-Key'], longKey, 'the disconnect itself keeps the full key');
    assert.ok(ref.length <= 100, `external_ref has ${ref.length} characters`);
    assert.notEqual(ref, longKey);
    assert.equal(first.result.work_order.data.id, 77);
    assert.equal((await disconnect(longKey)).calls[1].body.external_ref, ref, 'the same key gives the same ref, so a replay stays idempotent');
    assert.notEqual((await disconnect(`${'k'.repeat(127)}j`)).calls[1].body.external_ref, ref, 'another key gives another ref');

    const fits = 'e'.repeat(100);

    assert.equal((await disconnect(fits)).calls[1].body.external_ref, fits, 'a key that fits is used as is');
    assert.ok((await disconnect('e'.repeat(101))).calls[1].body.external_ref.length <= 100);
});

test('M18: list_onus and list_invoices offer only the states the API knows and refuse others before any HTTP call', async () => {
    const onus = toolSchema('list_onus');
    const invoices = toolSchema('list_invoices');

    assert.deepEqual(onus.inputSchema.properties.state.enum, ['online', 'offline', 'unknown', 'absent']);
    assert.equal(/\blos\b/i.test(JSON.stringify(onus)), false, 'los is not an ONU state');
    assert.deepEqual(invoices.inputSchema.properties.status.enum, ['draft', 'issued', 'void']);

    for (const state of ['online', 'offline', 'unknown', 'absent']) {
        const { calls } = await run('list_onus', { state }, { 'GET /network/onus': jsonResponse({ success: true, data: [], meta: { total: 0 } }) });

        assert.equal(calls[0].query.get('state'), state);
    }

    for (const status of ['draft', 'issued', 'void']) {
        const { calls } = await run('list_invoices', { status }, { 'GET /invoices': jsonResponse({ success: true, data: [], meta: { total: 0 } }) });

        assert.equal(calls[0].query.get('status'), status);
    }

    await assertRefused('list_onus', { state: 'los' });
    await assertRefused('list_invoices', { status: 'paid' });
});

test('M5: find_subscriber passes status, document and external_client_id and needs at least one criterion', async () => {
    const routes = { 'GET /subscribers': ONE_SUBSCRIBER };
    const filtered = await run('find_subscriber', { document: '30111222', external_client_id: 991, status: true }, routes);

    assert.deepEqual(sig(filtered.calls), ['GET /subscribers']);
    assert.deepEqual(Object.fromEntries(filtered.calls[0].query), { document: '30111222', external_client_id: '991', status: 'true' });

    const combined = await run('find_subscriber', { query: 'Perez', status: '0' }, routes);

    assert.deepEqual(Object.fromEntries(combined.calls[0].query), { q: 'Perez', status: 'false' });

    const byStatus = await run('find_subscriber', { status: false }, routes);

    assert.deepEqual(Object.fromEntries(byStatus.calls[0].query), { status: 'false' });

    for (const args of [
        {}, { query: '  ' }, { document: '30.111.222' }, { document: 'abc' }, { external_client_id: '12a' },
        { external_client_id: '9'.repeat(20) }, { status: 'maybe' }, { query: '#42', status: true }, { query: '#42', document: '30111222' },
    ]) {
        await assertRefused('find_subscriber', args);
    }

    const byNumber = await run('find_subscriber', { query: '#42' }, { 'GET /subscribers/42': jsonResponse({ success: true, data: { id: 42 } }) });

    assert.deepEqual(sig(byNumber.calls), ['GET /subscribers/42'], '#N keeps its exact lookup');
    assert.equal(toolSchema('find_subscriber').inputSchema.required, undefined, 'any one criterion is enough');
});

test('M7: list_internet_profiles lists active profiles by default and the other lifecycle statuses on request', async () => {
    const routes = { 'GET /internet-profiles': jsonResponse({ success: true, data: [], meta: { total: 0 } }) };
    const byDefault = await run('list_internet_profiles', {}, routes);

    assert.deepEqual(Object.fromEntries(byDefault.calls[0].query), { status: 'active', per_page: '100' });

    for (const status of ['active', 'deprecated', 'soft_deleted']) {
        const { calls } = await run('list_internet_profiles', { status }, routes);

        assert.deepEqual(Object.fromEntries(calls[0].query), { status, per_page: '100' });
    }

    assert.deepEqual(toolSchema('list_internet_profiles').inputSchema.properties.status.enum, ['active', 'deprecated', 'soft_deleted']);

    await assertRefused('list_internet_profiles', { status: 'draft' });
});

test('M14: locate_new_onu narrows the search to one OLT with olt_id and sends {mac} alone otherwise', async () => {
    const routes = {
        'POST /subscribers/42/onu/swap/locate': jsonResponse({
            success: true,
            data: { tasks: [{ olt_id: 6, olt_name: 'OLT 6', task_run_id: 11, request_id: 'r11' }], errors: [] },
        }, 202),
        'GET /tasks/11': jsonResponse(taskProjection(11, 'succeeded', { matches: [] })),
    };
    const args = { ...WRITE_ARGS, subscriber_id: 42, mac: 'B4:64:15:1B:DE:68' };

    assert.deepEqual((await run('locate_new_onu', { ...args, olt_id: 6 }, routes)).calls[0].body, { mac: 'B4:64:15:1B:DE:68', olt_id: 6 });
    assert.deepEqual((await run('locate_new_onu', { ...args, olt_id: '6' }, routes)).calls[0].body, { mac: 'B4:64:15:1B:DE:68', olt_id: 6 });
    assert.deepEqual((await run('locate_new_onu', args, routes)).calls[0].body, { mac: 'B4:64:15:1B:DE:68' });
    assert.equal(toolSchema('locate_new_onu').inputSchema.properties.olt_id.type, 'integer');

    for (const oltId of [0, -1, 1.5, 'x']) {
        await assertRefused('locate_new_onu', { ...args, olt_id: oltId });
    }
});
