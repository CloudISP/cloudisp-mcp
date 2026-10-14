/**
 * Tests for the CloudISP MCP stdio server.
 *
 * `node --test server.test.mjs` — no dependencies beyond Node 18+.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PassThrough } from 'node:stream';

import { awaitTask, dispatch, listTools, REDACTED_KEYS, startServer } from './server.mjs';

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
];

const WRITE_TOOL_NAMES = [
    'reboot_onu', 'set_onu_catv', 'change_subscriber_wifi', 'change_wifi_radio', 'sync_onu',
    'change_subscriber_plan', 'change_subscriber_bandwidth', 'disconnect_subscriber', 'reconnect_subscriber',
    'create_work_order', 'assign_work_order',
];

/** Arguments every write tool requires. */
const WRITE_ARGS = { idempotency_key: 'op-1', requested_by: 'Marcos Rivadeo' };

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
        { kind: 'routeros', device_id: 3, metric_ids: ['cpu', 'mem'], window: '24h', resolution: '5m' },
        routes,
    );
    assert.deepEqual(sig(series.calls), ['GET /network/devices/routeros/3/metrics/series']);
    assert.deepEqual(series.calls[0].query.getAll('metric_id[]'), ['cpu', 'mem']);
    assert.equal(series.calls[0].query.get('window'), '24h');
    assert.equal(series.calls[0].query.get('resolution'), '5m');

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
    assert.equal(technician.calls[0].query.get('q'), 'Olivera');
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

// ─── requested_by ────────────────────────────────────────────────────────────

test('every write tool refuses a missing requested_by without any HTTP call', async () => {
    for (const name of WRITE_TOOL_NAMES) {
        const { result, calls } = await run(name, { idempotency_key: 'op-1', subscriber_id: 42 });

        assert.equal(result.outcome, 'validation_failed', name);
        assert.match(result.message, /requested_by/, name);
        assert.equal(calls.length, 0, name);
    }
});

test('every write tool refuses a missing idempotency_key without any HTTP call', async () => {
    for (const name of WRITE_TOOL_NAMES) {
        const { result, calls } = await run(name, { requested_by: 'Ana', subscriber_id: 42 });

        assert.equal(result.outcome, 'validation_failed', name);
        assert.match(result.message, /idempotency_key/, name);
        assert.equal(calls.length, 0, name);
    }
});

test('requested_by reaches the API as an ASCII header and is refused beyond 120 characters', async () => {
    const routes = { 'POST /subscribers/42/plan': jsonResponse({ success: true, data: {} }) };
    const accented = await run('change_subscriber_plan', { ...WRITE_ARGS, requested_by: 'Peña Ñandú 🚀', subscriber_id: 42, plan_id: 8 }, routes);

    assert.equal(accented.calls[0].headers['X-CloudISP-Requested-By'], 'Pena Nandu');

    for (const requested_by of ['x'.repeat(121), '   ', '🚀']) {
        const refused = await run('change_subscriber_plan', { ...WRITE_ARGS, requested_by, subscriber_id: 42, plan_id: 8 }, routes);

        assert.equal(refused.result.outcome, 'validation_failed', requested_by);
        assert.equal(refused.calls.length, 0);
    }
});

test('read tools carry no requested_by header', async () => {
    const { calls } = await run('find_subscriber', { query: 'Perez' }, { 'GET /subscribers': ONE_SUBSCRIBER });

    assert.equal(calls[0].headers['X-CloudISP-Requested-By'], undefined);
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

test('annotations: every read is read-only (device reads included), every write is not, disconnect and reconnect are destructive', async () => {
    const tools = await listedTools({ CLOUDISP_ALLOW_WRITES: '1' });

    for (const tool of tools) {
        assert.equal(typeof tool.title, 'string', tool.name);
        assert.equal(tool.annotations.readOnlyHint, READ_TOOL_NAMES.includes(tool.name), tool.name);
    }

    for (const name of ['onu_read', 'onu_diagnose', 'olt_read', 'router_read']) {
        assert.equal(tools.find((tool) => tool.name === name).annotations.readOnlyHint, true, name);
    }

    for (const name of ['disconnect_subscriber', 'reconnect_subscriber']) {
        assert.equal(tools.find((tool) => tool.name === name).annotations.destructiveHint, true, name);
    }
});

test('every write tool starts with the confirmation prefix and requires idempotency_key and requested_by', async () => {
    const tools = await listedTools({ CLOUDISP_ALLOW_WRITES: '1' });

    for (const name of WRITE_TOOL_NAMES) {
        const tool = tools.find((candidate) => candidate.name === name);

        assert.ok(tool.description.startsWith('ESCRITURA (requiere confirmación del operador): '), name);
        assert.ok(tool.inputSchema.required.includes('idempotency_key'), name);
        assert.ok(tool.inputSchema.required.includes('requested_by'), name);
    }

    for (const name of READ_TOOL_NAMES) {
        assert.ok(!tools.find((candidate) => candidate.name === name).description.startsWith('ESCRITURA'), name);
    }
});

test('every tool that takes a subscriber offers subscriber_id and subscriber_query', async () => {
    const tools = await listedTools({ CLOUDISP_ALLOW_WRITES: '1' });
    const bySubscriber = ['get_subscriber', 'diagnose_subscriber', 'onu_read', 'onu_diagnose', 'list_onus', 'list_invoices', 'find_work_orders',
        'reboot_onu', 'set_onu_catv', 'change_subscriber_wifi', 'change_wifi_radio', 'sync_onu', 'change_subscriber_plan',
        'change_subscriber_bandwidth', 'disconnect_subscriber', 'reconnect_subscriber', 'create_work_order', 'assign_work_order'];

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

    assert.equal(serverInfo.version, '0.3.0');
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
    assert.equal(initialize.result.serverInfo.version, '0.3.0');
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
