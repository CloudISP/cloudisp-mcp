#!/usr/bin/env node
/**
 * CloudISP MCP stdio server.
 *
 * Zero-dependency Node 18+ Model Context Protocol server that bridges agent tool
 * calls onto the bearer-key public API (`/api/v1/public/*`). The process holds
 * only `CLOUDISP_API_BASE` and `CLOUDISP_API_KEY`; it never opens a database
 * connection and never writes the key or the `Authorization` header anywhere.
 *
 * Transport is newline-delimited JSON over stdin/stdout (one JSON-RPC message per
 * line, the framing `@modelcontextprotocol/sdk` uses for stdio). Only
 * `initialize`, `tools/list` and `tools/call` (plus `ping`) are implemented.
 */

import { pathToFileURL } from 'node:url';

const SERVER_NAME = 'cloudisp-mcp';
const SERVER_VERSION = '0.3.0';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const API_PREFIX = '/api/v1/public';
const REQUEST_TIMEOUT_MS = 30000;

/** How long (and how often) a dispatched device task is polled before the tool answers `pending`. */
const TASK_TIMEOUT_MS = 40000;
const TASK_INTERVAL_MS = 2000;

/** Header carrying who asked for a write; the API logs it and stamps it on audit text. */
const REQUESTED_BY_HEADER = 'X-CloudISP-Requested-By';
const REQUESTED_BY_MAX_LENGTH = 120;

/** Description prefix of every write tool. */
const WRITE_PREFIX = 'ESCRITURA (requiere confirmación del operador): ';

/** Hint handed to the client during `initialize`: the agent's core rules, condensed. */
const INSTRUCTIONS = [
    'Llamá cloudisp_context al iniciar cada conversación y antes de delegar; obedecé sus reglas y artículos.',
    'Nunca adivines ids: resolvé al abonado con búsqueda y, si hay más de uno, preguntá mostrando candidatos. Dato faltante = "no disponible", nunca 0.',
    'Toda escritura: resumen (abonado, id, plataforma, ONU, acción, impacto) y confirmación explícita del operador antes de llamar la tool; una acción por confirmación, nunca encadenes escrituras.',
    'Pasá siempre requested_by con el nombre de quien pidió y una idempotency_key nueva por acción (reusala solo para reintentar la misma).',
    'Nunca muestres contraseñas, PSK, documentos ni teléfonos. No podés crear, editar ni borrar OLTs, routers, masters, plataformas ni perfiles. Subagentes: solo lecturas.',
    'Si una tool devuelve platform_policy_denied, actor_forbidden o daily_write_limit_reached, informalo y no reintentes. Las escrituras requieren CLOUDISP_ALLOW_WRITES=1.',
].join('\n');

/** Payload returned for a write tool while the write guardrail is on. */
const WRITES_DISABLED_MESSAGE = 'Write tools are disabled. Set CLOUDISP_ALLOW_WRITES=1 in the environment '
    + 'config and use a key with write scopes.';

/** Same rule the public API applies to the `Idempotency-Key` header. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Whether the write guardrail is off for this environment.
 *
 * @param {Record<string, string|undefined>} env Environment bag.
 * @return {boolean} True only when `CLOUDISP_ALLOW_WRITES` is exactly `1`.
 */
function writesEnabled(env) {
    return env?.CLOUDISP_ALLOW_WRITES === '1';
}

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Read the runtime configuration from the environment.
 *
 * @return {{ base: string, key: string, configured: boolean, valid: boolean }} Normalized config; `configured` is false when either value is missing, `valid` is true only for https or loopback http.
 */
function readConfig() {
    const base = (process.env.CLOUDISP_API_BASE || '').trim().replace(/\/+$/, '');
    const key = (process.env.CLOUDISP_API_KEY || '').trim();
    let valid = false;

    try {
        const url = new URL(base);
        valid = url.protocol === 'https:'
            || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    } catch {
        valid = false;
    }

    return { base, key, configured: base !== '' && key !== '', valid };
}

/** Symbol key (invisible to JSON) that carries the HTTP status of a failed API response to `classifyOutcome`. */
const HTTP_STATUS = Symbol('httpStatus');

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * A tool-level failure whose payload is returned verbatim by `dispatch`.
 */
class ToolError extends Error {
    /**
     * @param {object} payload JSON-serializable error payload.
     */
    constructor(payload) {
        super(typeof payload === 'object' && payload !== null && typeof payload.error === 'string' ? payload.error : 'tool_error');
        this.payload = payload;
    }
}

/**
 * Abort the current tool with a structured payload.
 *
 * @param {object} payload JSON-serializable error payload.
 * @return {never}
 */
function fail(payload) {
    throw new ToolError(payload);
}

/**
 * Build the standard shape validation failure.
 *
 * @param {string} message Human-readable reason.
 * @return {object}
 */
function invalid(message) {
    return { error: 'validation_failed', message };
}

/**
 * Fall back to a synthesized error envelope when the API returned no JSON body.
 *
 * @param {{ status: number, body: unknown }} response Normalized response.
 * @return {object}
 */
function apiFailurePayload(response) {
    const payload = isPlainObject(response.body)
        ? response.body
        : {
            success: false,
            error: { code: 'http_error', message: `The public API answered HTTP ${response.status} with no JSON body.` },
        };

    payload[HTTP_STATUS] = response.status;

    return payload;
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

/**
 * Perform one public API request.
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {string} method HTTP method.
 * @param {string} path Path below `/api/v1/public`.
 * @param {{ query?: object, body?: object, idempotencyKey?: string }} [options] Optional query string, JSON body and idempotency header.
 * @return {Promise<{ ok: boolean, status: number, body: unknown }>} Normalized response.
 */
async function apiRequest(fetchImpl, method, path, options = {}) {
    const config = readConfig();
    const url = new URL(`${config.base}${API_PREFIX}${path}`);

    for (const [name, value] of Object.entries(options.query || {})) {
        if (Array.isArray(value)) {
            value.forEach((item) => url.searchParams.append(`${name}[]`, String(item)));
        } else if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(name, String(value));
        }
    }

    const headers = { Authorization: `Bearer ${config.key}`, Accept: 'application/json' };
    const init = { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };

    if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(options.body);
    }

    if (options.idempotencyKey) {
        headers['Idempotency-Key'] = options.idempotencyKey;
    }

    const response = await fetchImpl(url.toString(), init);

    let body = null;
    try {
        body = await response.json();
    } catch {
        body = null;
    }

    const status = Number.isInteger(response.status) ? response.status : 200;
    const ok = typeof response.ok === 'boolean' ? response.ok : status >= 200 && status < 300;

    return { ok, status, body };
}

/**
 * Whether a normalized response carries a failed public API envelope.
 *
 * @param {{ ok: boolean, body: unknown }} response Normalized response.
 * @return {boolean}
 */
function isFailure(response) {
    return !response.ok || (isPlainObject(response.body) && response.body.success === false);
}

// ─── Argument helpers ────────────────────────────────────────────────────────

/**
 * @param {unknown} value Candidate value.
 * @return {boolean} True for a non-null, non-array object.
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value Candidate value.
 * @return {boolean} True when the value is present (not undefined/null/empty string).
 */
function isPresent(value) {
    return value !== undefined && value !== null && value !== '';
}

/**
 * Coerce an integer-or-numeric-string input to a positive integer.
 *
 * @param {unknown} value Candidate value.
 * @return {number|null} The value, or null when it is not a positive integer.
 */
function asPositiveInt(value) {
    if (typeof value === 'number') {
        return Number.isInteger(value) && value > 0 ? value : null;
    }

    if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) {
        const parsed = Number(value.trim());

        return parsed > 0 ? parsed : null;
    }

    return null;
}

/**
 * @param {unknown} value Candidate value.
 * @return {string} The trimmed string, or an empty string.
 */
function asTrimmedString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Require a non-empty `query` argument.
 *
 * @param {unknown} value Candidate value.
 * @return {string} The trimmed query.
 */
function requireQuery(value) {
    const query = asTrimmedString(value);

    if (query === '') {
        fail(invalid('query is required.'));
    }

    return query;
}

/**
 * Require a well-formed `idempotency_key` argument.
 *
 * @param {object} args Tool arguments.
 * @return {string} The idempotency key.
 */
function requireIdempotencyKey(args) {
    const value = args.idempotency_key;

    if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
        fail(invalid('idempotency_key is required and must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$.'));
    }

    return value;
}

/**
 * Require the `requested_by` argument: who asked for the change, 1 to 120 characters.
 *
 * @param {object} args Tool arguments.
 * @return {string} The value as an ASCII-only header (accents folded), so it reaches the audit trail unmangled.
 */
function requireRequestedBy(args) {
    const value = asTrimmedString(args.requested_by);
    const header = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]+/g, ' ').trim();

    if (value.length > REQUESTED_BY_MAX_LENGTH || header === '') {
        fail(invalid('requested_by is required: the name of the person who asked for the change (1 to 120 characters).'));
    }

    return header;
}

/**
 * Wrap `fetch` so every request of a write tool, lookups included, carries who asked for it.
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {string} requestedBy Header-safe requester name.
 * @return {Function} `fetch`-compatible implementation.
 */
function withRequestedBy(fetchImpl, requestedBy) {
    return (url, init) => fetchImpl(url, { ...init, headers: { ...init?.headers, [REQUESTED_BY_HEADER]: requestedBy } });
}

/**
 * Require a positive-integer argument.
 *
 * @param {object} args Tool arguments.
 * @param {string} key Argument name.
 * @return {number} The id.
 */
function requireId(args, key) {
    const id = asPositiveInt(args[key]);

    if (id === null) {
        fail(invalid(`${key} is required and must be a positive integer.`));
    }

    return id;
}

/**
 * Read an optional integer argument.
 *
 * @param {object} args Tool arguments.
 * @param {string} key Argument name.
 * @param {number} [min] Smallest accepted value (defaults to 1).
 * @return {number|undefined} The value, or undefined when absent.
 */
function optInt(args, key, min = 1) {
    if (!isPresent(args[key])) {
        return undefined;
    }

    const raw = args[key];
    const value = typeof raw === 'string' && /^[0-9]+$/.test(raw.trim()) ? Number(raw.trim()) : raw;

    if (!Number.isInteger(value) || value < min) {
        fail(invalid(`${key} must be an integer >= ${min}.`));
    }

    return value;
}

/**
 * @param {object} args Tool arguments.
 * @return {{ page: number|undefined, per_page: number|undefined }} Optional pagination query.
 */
function pageQuery(args) {
    return { page: optInt(args, 'page'), per_page: optInt(args, 'per_page') };
}

/**
 * Resolve exactly one of `subscriber_id` or `subscriber_query` to a subscriber id.
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} args Tool arguments.
 * @param {{ optional?: boolean }} [options] With `optional`, neither argument yields `null` instead of a validation failure.
 * @return {Promise<number|null>} The subscriber id (`null` only when optional and absent).
 */
async function resolveSubscriberId(fetchImpl, args, { optional = false } = {}) {
    const hasId = isPresent(args.subscriber_id);
    const query = asTrimmedString(args.subscriber_query);

    if (optional && !hasId && query === '') {
        return null;
    }

    if (hasId === (query !== '')) {
        fail(invalid('Provide exactly one of subscriber_id or subscriber_query.'));
    }

    if (hasId) {
        const id = asPositiveInt(args.subscriber_id);

        if (id === null) {
            fail(invalid('subscriber_id must be a positive integer.'));
        }

        return id;
    }

    const subscriber = await findSingleSubscriber(fetchImpl, query);

    return subscriber.id;
}

/**
 * Look a subscriber up by text query and require exactly one match.
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {string} query Name or document fragment.
 * @return {Promise<object>} The single serialized subscriber row.
 */
async function findSingleSubscriber(fetchImpl, query) {
    const response = await apiRequest(fetchImpl, 'GET', '/subscribers', { query: { q: query } });

    if (!response.ok) {
        fail(apiFailurePayload(response));
    }

    const rows = Array.isArray(response.body?.data) ? response.body.data : [];

    if (response.body?.meta?.total !== 1 || rows.length !== 1) {
        fail({ error: 'ambiguous_subscriber', candidates: rows });
    }

    return rows[0];
}

/**
 * Require exactly one employee lookup match.
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {string} query Name fragment.
 * @return {Promise<object>} The single serialized employee row.
 */
async function findSingleEmployee(fetchImpl, query) {
    const response = await apiRequest(fetchImpl, 'GET', '/employees', { query: { q: query } });

    if (!response.ok) {
        fail(apiFailurePayload(response));
    }

    const rows = Array.isArray(response.body?.data) ? response.body.data : [];

    if (response.body?.meta?.total !== 1 || rows.length !== 1) {
        fail({ error: 'ambiguous_technician', candidates: rows });
    }

    return rows[0];
}

/**
 * Resolve the single pending work order of one type for a subscriber.
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {number} subscriberId Subscriber id.
 * @param {string} type Work order type key.
 * @return {Promise<object>} The single pending work order.
 */
async function findPendingWorkOrder(fetchImpl, subscriberId, type) {
    const response = await apiRequest(fetchImpl, 'GET', '/work-orders', {
        query: { client_id: subscriberId, type, status: 'pending' },
    });

    if (isFailure(response)) {
        fail(apiFailurePayload(response));
    }

    const rows = Array.isArray(response.body?.data) ? response.body.data : [];

    if (response.body?.meta?.total !== 1 || rows.length !== 1) {
        fail({ error: 'ambiguous_work_order', candidates: rows });
    }

    return rows[0];
}

// ─── Tool handlers ───────────────────────────────────────────────────────────

/**
 * `find_subscriber` — `GET /subscribers?q=`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function findSubscriber(args, fetchImpl) {
    const query = requireQuery(args.query);
    const response = await apiRequest(fetchImpl, 'GET', '/subscribers', { query: { q: query } });

    return isFailure(response) ? apiFailurePayload(response) : response.body;
}

/**
 * `list_internet_profiles` — `GET /internet-profiles?status=active&per_page=100` (the API maximum; the default page is 20).
 *
 * @param {object} _args Tool arguments (unused).
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function listInternetProfiles(_args, fetchImpl) {
    const response = await apiRequest(fetchImpl, 'GET', '/internet-profiles', { query: { status: 'active', per_page: 100 } });

    return isFailure(response) ? apiFailurePayload(response) : response.body;
}

/**
 * `change_subscriber_bandwidth` — resolves the subscriber, then `POST /subscribers/{id}/bandwidth`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function changeSubscriberBandwidth(args, fetchImpl) {
    const idempotencyKey = requireIdempotencyKey(args);
    const subscriberId = await resolveSubscriberId(fetchImpl, args);

    const hasProfileId = isPresent(args.profile_id);
    const hasDownloadLimit = isPresent(args.download_max_limit);

    if (hasProfileId === hasDownloadLimit) {
        fail(invalid('Provide exactly one of profile_id or download_max_limit.'));
    }

    let body;
    if (hasProfileId) {
        const profileId = asPositiveInt(args.profile_id);

        if (profileId === null) {
            fail(invalid('profile_id must be a positive integer.'));
        }

        body = { profile_id: profileId };
    } else {
        const limit = asPositiveInt(args.download_max_limit);

        if (limit === null) {
            fail(invalid('download_max_limit must be a positive integer.'));
        }

        body = { download_max_limit: limit };
    }

    const response = await apiRequest(fetchImpl, 'POST', `/subscribers/${subscriberId}/bandwidth`, {
        body,
        idempotencyKey,
    });

    return isFailure(response) ? apiFailurePayload(response) : response.body;
}

/**
 * `disconnect_subscriber` — resolves the subscriber, then `POST /subscribers/{id}/disconnect`,
 * optionally opening a linked work order keyed by the same idempotency token.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Disconnect envelope, plus `work_order` or `work_order_error` when requested.
 */
async function disconnectSubscriber(args, fetchImpl) {
    const idempotencyKey = requireIdempotencyKey(args);
    const scope = requireScope(args);
    const subscriberId = await resolveSubscriberId(fetchImpl, args);

    const response = await apiRequest(fetchImpl, 'POST', `/subscribers/${subscriberId}/disconnect`, { body: { scope }, idempotencyKey });

    if (isFailure(response)) {
        return apiFailurePayload(response);
    }

    const result = response.body;

    if (args.open_work_order !== true) {
        return result;
    }

    const type = asTrimmedString(args.work_order_type) || 'technical_service';
    const title = asTrimmedString(args.work_order_title) || `Desconexión de abonado ${subscriberId}`;
    const workOrder = await apiRequest(fetchImpl, 'POST', '/work-orders', {
        body: { client_id: subscriberId, type, title, external_ref: idempotencyKey },
    });

    if (isFailure(workOrder)) {
        return { ...result, work_order_error: apiFailurePayload(workOrder) };
    }

    return { ...result, work_order: workOrder.body };
}

/**
 * `find_work_orders` — optional subscriber (`subscriber_id` or `subscriber_query`), optional `type`/`status`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function findWorkOrders(args, fetchImpl) {
    const clientId = await resolveSubscriberId(fetchImpl, args, { optional: true });

    return call(fetchImpl, 'GET', '/work-orders', {
        query: { client_id: clientId, type: asTrimmedString(args.type), status: asTrimmedString(args.status), ...pageQuery(args) },
    });
}

/**
 * `find_technician` — `GET /employees?q=`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function findTechnician(args, fetchImpl) {
    const query = requireQuery(args.query);
    const response = await apiRequest(fetchImpl, 'GET', '/employees', { query: { q: query } });

    return isFailure(response) ? apiFailurePayload(response) : response.body;
}

/**
 * `assign_work_order` — resolves one pending work order and one technician, then
 * `POST /work-orders/{id}/assign`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function assignWorkOrder(args, fetchImpl) {
    const idempotencyKey = requireIdempotencyKey(args);
    const hasWorkOrderId = isPresent(args.work_order_id);
    const hasSubscriber = isPresent(args.subscriber_id) || asTrimmedString(args.subscriber_query) !== '';

    if (hasWorkOrderId === hasSubscriber) {
        fail(invalid('Provide exactly one of work_order_id or a subscriber (subscriber_id or subscriber_query) together with type.'));
    }

    const hasEmployeeId = isPresent(args.employee_id);
    const technicianQuery = asTrimmedString(args.technician_query);

    if (hasEmployeeId === (technicianQuery !== '')) {
        fail(invalid('Provide exactly one of employee_id or technician_query.'));
    }

    const type = asTrimmedString(args.type);

    if (hasSubscriber && type === '') {
        fail(invalid('type is required when the work order is resolved from a subscriber.'));
    }

    let workOrderId;
    if (hasWorkOrderId) {
        workOrderId = requireId(args, 'work_order_id');
    } else {
        const subscriberId = await resolveSubscriberId(fetchImpl, args);
        workOrderId = (await findPendingWorkOrder(fetchImpl, subscriberId, type)).id;
    }

    const employeeId = hasEmployeeId
        ? requireId(args, 'employee_id')
        : (await findSingleEmployee(fetchImpl, technicianQuery)).id;

    return call(fetchImpl, 'POST', `/work-orders/${workOrderId}/assign`, { body: { employee_id: employeeId }, idempotencyKey });
}

/**
 * `network_snapshot` — `GET /operations/snapshot`.
 *
 * @param {object} _args Tool arguments (unused).
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function networkSnapshot(_args, fetchImpl) {
    const response = await apiRequest(fetchImpl, 'GET', '/operations/snapshot');

    return isFailure(response) ? apiFailurePayload(response) : response.body;
}

// ─── Task polling ────────────────────────────────────────────────────────────

/** Real timers; tests inject a virtual clock. */
const REAL_CLOCK = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

/** Final values of the task status vocabulary (`TaskStatusProjection`). */
const TERMINAL_TASK_STATUSES = ['succeeded', 'failed', 'canceled'];

/**
 * Issue one request and return the public API envelope, or its failure payload.
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {string} method HTTP method.
 * @param {string} path Path below `/api/v1/public`.
 * @param {object} [options] See {@link apiRequest}.
 * @return {Promise<object>} Public API envelope or failure payload.
 */
async function call(fetchImpl, method, path, options) {
    const response = await apiRequest(fetchImpl, method, path, options);

    return isFailure(response) ? apiFailurePayload(response) : response.body;
}

/**
 * Poll `GET /tasks/{id}` until the task reaches a final status or the time budget runs out.
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {number} taskRunId Task run id.
 * @param {{ timeoutMs?: number, intervalMs?: number, now?: Function, sleep?: Function }} [options] Budget and clock seams.
 * @return {Promise<object>} The final task projection, or `{ status: 'pending', task_run_id }` when time ran out.
 */
export async function awaitTask(fetchImpl, taskRunId, options = {}) {
    const {
        timeoutMs = TASK_TIMEOUT_MS, intervalMs = TASK_INTERVAL_MS, now = REAL_CLOCK.now, sleep = REAL_CLOCK.sleep,
    } = options;
    const deadline = now() + timeoutMs;

    for (;;) {
        let response;

        try {
            response = await apiRequest(fetchImpl, 'GET', `/tasks/${taskRunId}`);
        } catch {
            break; // transport hiccup: the task was accepted, report it pending and let the caller get_task later
        }

        // A projection carries `success: false` while it is still running, so only the HTTP status marks a failed poll.
        if (!response.ok) {
            return { ...apiFailurePayload(response), task_run_id: taskRunId };
        }

        if (TERMINAL_TASK_STATUSES.includes(response.body?.status)) {
            return response.body;
        }

        if (now() >= deadline) {
            break;
        }

        await sleep(Math.min(intervalMs, deadline - now()));
    }

    return { status: 'pending', task_run_id: taskRunId };
}

/**
 * Turn a device-task dispatch response into its final task projection.
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @param {{ ok: boolean, status: number, body: unknown }} response Normalized dispatch response.
 * @return {Promise<object>} Failure payload, the dispatch body when it carries no task, or the awaited projection (with `replayed` when the API reported it).
 */
async function awaitDispatched(fetchImpl, clock, response) {
    if (isFailure(response)) {
        return apiFailurePayload(response);
    }

    const body = response.body;
    const taskRunId = asPositiveInt(body?.task_run_id ?? body?.data?.task_run_id);

    if (taskRunId === null) {
        return body;
    }

    const task = await awaitTask(fetchImpl, taskRunId, clock);
    const replayed = body.replayed ?? body.data?.replayed;

    return replayed === undefined ? task : { ...task, replayed };
}

// ─── Read handlers ───────────────────────────────────────────────────────────

/** ONU read operations `POST /subscribers/{id}/onu/reads` accepts. */
const ONU_READ_OPERATIONS = [
    'olt.onu_details_read', 'olt.onu_health_check', 'onu.tr069_read', 'onu.wan_read',
    'onu.wifi_read', 'onu.catv_read', 'onu.wifi_diagnose',
];

/** OLT read operations the public API may enable (netwatcher routable ∩ admin allowlist). */
const OLT_READ_OPERATIONS = [
    'olt.health_check', 'olt.system_info_read', 'olt.mac_table_read', 'olt.unprovisioned_onus_read', 'olt.poll',
];

/** Router read operations netwatcher's RouterOS worker actually executes. */
const ROUTER_READ_OPERATIONS = ['routeros.health_check', 'routeros.test_command', 'routeros.interface_monitor_traffic'];

/** The only `command` values `routeros.test_command` accepts (netwatcher PARAMETER_SCHEMA enum). */
const ROUTER_TEST_COMMANDS = ['/system/identity/print', '/system/resource/print', '/interface/print', '/ip/address/print'];

/** Device kinds that have metrics. */
const DEVICE_KINDS = ['routeros', 'olt'];

/**
 * Require an `operation` argument from a closed list.
 *
 * @param {object} args Tool arguments.
 * @param {string[]} allowed Allowed operations.
 * @return {string} The operation.
 */
function requireOperation(args, allowed) {
    const operation = asTrimmedString(args.operation);

    if (!allowed.includes(operation)) {
        fail(invalid(`operation must be one of: ${allowed.join(', ')}.`));
    }

    return operation;
}

/**
 * Dispatch a device read and wait for its result.
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @param {string} path Reads endpoint below `/api/v1/public`.
 * @param {string} operation Validated operation.
 * @param {object} args Tool arguments (`parameters` is passed through).
 * @return {Promise<object>} Final task projection, or the failure payload.
 */
async function postRead(fetchImpl, clock, path, operation, args) {
    const parameters = isPlainObject(args.parameters) ? args.parameters : {};

    return awaitDispatched(fetchImpl, clock, await apiRequest(fetchImpl, 'POST', path, { body: { operation, parameters } }));
}

/**
 * `cloudisp_context` — `GET /agent/context`.
 *
 * @param {object} _args Tool arguments (unused).
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function cloudispContext(_args, fetchImpl) {
    return call(fetchImpl, 'GET', '/agent/context');
}

/**
 * `search_knowledge` — `GET /agent/knowledge?q=` or `GET /agent/knowledge/{id}`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function searchKnowledge(args, fetchImpl) {
    const hasArticleId = isPresent(args.article_id);
    const query = asTrimmedString(args.query);

    if (hasArticleId === (query !== '')) {
        fail(invalid('Provide exactly one of query or article_id.'));
    }

    if (hasArticleId) {
        return call(fetchImpl, 'GET', `/agent/knowledge/${requireId(args, 'article_id')}`);
    }

    if (query.length < 2 || query.length > 100) {
        fail(invalid('query must be 2 to 100 characters.'));
    }

    return call(fetchImpl, 'GET', '/agent/knowledge', { query: { q: query } });
}

/**
 * Build a handler for `GET /subscribers/{id}<suffix>` on the resolved subscriber.
 *
 * @param {string} suffix Path suffix below the subscriber.
 * @return {Function} Tool handler.
 */
const subscriberRead = (suffix) => async (args, fetchImpl) => {
    const subscriberId = await resolveSubscriberId(fetchImpl, args);

    return call(fetchImpl, 'GET', `/subscribers/${subscriberId}${suffix}`);
};

/** `get_subscriber` — `GET /subscribers/{id}`. */
const getSubscriber = subscriberRead('');

/** `diagnose_subscriber` — `GET /subscribers/{id}/diagnosis`. */
const diagnoseSubscriber = subscriberRead('/diagnosis');

/**
 * `onu_read` — `POST /subscribers/{id}/onu/reads`, then waits for the task.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @return {Promise<object>} Final task projection, or the failure payload.
 */
async function onuRead(args, fetchImpl, clock) {
    const operation = requireOperation(args, ONU_READ_OPERATIONS);
    const subscriberId = await resolveSubscriberId(fetchImpl, args);

    return postRead(fetchImpl, clock, `/subscribers/${subscriberId}/onu/reads`, operation, args);
}

/**
 * `onu_diagnose` — `POST /subscribers/{id}/onu/diagnose` (sync, observe only), then waits for the task.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @return {Promise<object>} Final task projection, or the failure payload.
 */
async function onuDiagnose(args, fetchImpl, clock) {
    const subscriberId = await resolveSubscriberId(fetchImpl, args);

    return awaitDispatched(fetchImpl, clock, await apiRequest(fetchImpl, 'POST', `/subscribers/${subscriberId}/onu/diagnose`, { body: {} }));
}

/**
 * `get_task` — `GET /tasks/{id}`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Task projection, or the failure payload.
 */
async function getTask(args, fetchImpl) {
    return call(fetchImpl, 'GET', `/tasks/${requireId(args, 'task_run_id')}`);
}

/**
 * `list_onus` — `GET /network/onus`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function listOnus(args, fetchImpl) {
    const clientId = await resolveSubscriberId(fetchImpl, args, { optional: true });

    return call(fetchImpl, 'GET', '/network/onus', {
        query: {
            state: asTrimmedString(args.state),
            client_id: clientId,
            olt_id: optInt(args, 'olt_id'),
            pon_slot: optInt(args, 'pon_slot', 0),
            pon_port: optInt(args, 'pon_port', 0),
            ...pageQuery(args),
        },
    });
}

/**
 * `list_olts` — `GET /network/olts`.
 *
 * @param {object} _args Tool arguments (unused).
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function listOlts(_args, fetchImpl) {
    return call(fetchImpl, 'GET', '/network/olts');
}

/**
 * `get_olt` — `GET /network/olts/{id}`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function getOlt(args, fetchImpl) {
    return call(fetchImpl, 'GET', `/network/olts/${requireId(args, 'olt_id')}`);
}

/**
 * `olt_read` — `POST /network/olts/{id}/reads`, then waits for the task.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @return {Promise<object>} Final task projection, or the failure payload.
 */
async function oltRead(args, fetchImpl, clock) {
    const operation = requireOperation(args, OLT_READ_OPERATIONS);

    return postRead(fetchImpl, clock, `/network/olts/${requireId(args, 'olt_id')}/reads`, operation, args);
}

/**
 * `list_routers` — `GET /network/routers`.
 *
 * @param {object} _args Tool arguments (unused).
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function listRouters(_args, fetchImpl) {
    return call(fetchImpl, 'GET', '/network/routers');
}

/**
 * `router_read` — `POST /network/routers/{id}/reads`, then waits for the task.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @return {Promise<object>} Final task projection, or the failure payload.
 */
async function routerRead(args, fetchImpl, clock) {
    const operation = requireOperation(args, ROUTER_READ_OPERATIONS);
    const routerId = requireId(args, 'router_id');
    let parameters = isPlainObject(args.parameters) ? args.parameters : {};

    if (operation === 'routeros.test_command') {
        const command = args.command ?? parameters.command;

        if (!ROUTER_TEST_COMMANDS.includes(command)) {
            fail(invalid(`command is required for routeros.test_command and must be one of: ${ROUTER_TEST_COMMANDS.join(', ')}.`));
        }

        parameters = { ...parameters, command };
    }

    return postRead(fetchImpl, clock, `/network/routers/${routerId}/reads`, operation, { parameters });
}

/**
 * `network_alerts` — `GET /network/alerts?limit=`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function networkAlerts(args, fetchImpl) {
    return call(fetchImpl, 'GET', '/network/alerts', { query: { limit: optInt(args, 'limit') } });
}

/**
 * `device_metrics` — the metric catalogue of a device, or the series of the requested `metric_ids`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function deviceMetrics(args, fetchImpl) {
    const kind = asTrimmedString(args.kind);

    if (!DEVICE_KINDS.includes(kind)) {
        fail(invalid(`kind must be one of: ${DEVICE_KINDS.join(', ')}.`));
    }

    const base = `/network/devices/${kind}/${requireId(args, 'device_id')}/metrics`;

    if (isPresent(args.metric_ids) && !Array.isArray(args.metric_ids)) {
        fail(invalid('metric_ids must be an array of metric ids.'));
    }

    const metricIds = (args.metric_ids ?? []).map(String);

    if (metricIds.length === 0) {
        return call(fetchImpl, 'GET', `${base}/catalog`);
    }

    return call(fetchImpl, 'GET', `${base}/series`, {
        query: { metric_id: metricIds, window: asTrimmedString(args.window), resolution: asTrimmedString(args.resolution) },
    });
}

/**
 * `platform_logs` — `GET /logs/events` for one platform.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function platformLogs(args, fetchImpl) {
    const platformId = requireId(args, 'platform_id');

    if (isPresent(args.severity) && !Array.isArray(args.severity)) {
        fail(invalid('severity must be an array.'));
    }

    return call(fetchImpl, 'GET', '/logs/events', {
        query: {
            platform_id: platformId,
            since: asTrimmedString(args.since),
            until: asTrimmedString(args.until),
            kind: asTrimmedString(args.kind),
            device_kind: asTrimmedString(args.device_kind),
            device_id: optInt(args, 'device_id'),
            severity: args.severity,
            q: asTrimmedString(args.q),
            limit: optInt(args, 'limit'),
        },
    });
}

/**
 * `list_reports` — `GET /reports`.
 *
 * @param {object} _args Tool arguments (unused).
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function listReports(_args, fetchImpl) {
    return call(fetchImpl, 'GET', '/reports');
}

/**
 * `run_report` — `GET /reports/{key}` with the report's declared filters as the query string.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function runReport(args, fetchImpl) {
    const key = asTrimmedString(args.key);

    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) {
        fail(invalid('key is required: a report key from list_reports.'));
    }

    const query = isPlainObject(args.filters) ? { ...args.filters } : {};
    const platformId = optInt(args, 'platform_id');

    if (platformId !== undefined) {
        query.platform_id = platformId;
    }

    return call(fetchImpl, 'GET', `/reports/${key}`, { query });
}

/**
 * `get_work_order` — `GET /work-orders/{id}`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function getWorkOrder(args, fetchImpl) {
    return call(fetchImpl, 'GET', `/work-orders/${requireId(args, 'work_order_id')}`);
}

/**
 * `list_plans` — `GET /plans` (the API maximum page unless `per_page` is given).
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function listPlans(args, fetchImpl) {
    return call(fetchImpl, 'GET', '/plans', {
        query: { status: asTrimmedString(args.status), page: optInt(args, 'page'), per_page: optInt(args, 'per_page') ?? 100 },
    });
}

/**
 * `list_invoices` — `GET /invoices`, optionally for one subscriber.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function listInvoices(args, fetchImpl) {
    const subscriberId = await resolveSubscriberId(fetchImpl, args, { optional: true });

    return call(fetchImpl, 'GET', '/invoices', {
        query: { subscriber_id: subscriberId, status: asTrimmedString(args.status), ...pageQuery(args) },
    });
}

// ─── Write handlers ──────────────────────────────────────────────────────────

/** Service scopes of a disconnect/reconnect. */
const SERVICE_SCOPES = ['internet', 'catv', 'all'];

/** Fields of the SSID write that default to what the preceding WiFi read reported. */
const WIFI_SSID_FIELDS = ['enabled', 'name', 'hidden', 'auth_mode', 'encrypt_type'];

/**
 * @param {object} args Tool arguments.
 * @return {string} The requested service scope, `internet` by default.
 */
function requireScope(args) {
    const scope = isPresent(args.scope) ? args.scope : 'internet';

    if (!SERVICE_SCOPES.includes(scope)) {
        fail(invalid(`scope must be one of: ${SERVICE_SCOPES.join(', ')}.`));
    }

    return scope;
}

/**
 * Dispatch one ONU write and wait for its task.
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @param {number} subscriberId Subscriber id.
 * @param {string} idempotencyKey Replay token.
 * @param {string} operation Write operation.
 * @param {object} parameters Operation parameters.
 * @return {Promise<object>} Final task projection, or the failure payload.
 */
async function onuAction(fetchImpl, clock, subscriberId, idempotencyKey, operation, parameters) {
    const response = await apiRequest(fetchImpl, 'POST', `/subscribers/${subscriberId}/onu/actions`, {
        body: { operation, parameters },
        idempotencyKey,
    });

    return awaitDispatched(fetchImpl, clock, response);
}

/**
 * Run the fresh `onu.wifi_read` every WiFi write must be based on; abort the write unless it succeeded.
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @param {number} subscriberId Subscriber id.
 * @return {Promise<object>} The successful read projection (with a positive `task_run_id`).
 */
async function requireWifiRead(fetchImpl, clock, subscriberId) {
    const read = await postRead(fetchImpl, clock, `/subscribers/${subscriberId}/onu/reads`, 'onu.wifi_read', {});

    if (read?.success === true && asPositiveInt(read.task_run_id) !== null) {
        return read;
    }

    if (read?.status === 'pending') {
        fail({ error: 'wifi_read_pending', task_run_id: read.task_run_id, message: 'The WiFi read did not finish in time; nothing was written. Retry later.' });
    }

    return fail(read ?? { error: 'wifi_read_failed', message: 'The WiFi read returned no result; nothing was written.' });
}

/**
 * `reboot_onu` — `POST /subscribers/{id}/onu/actions` with `onu.reboot`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @return {Promise<object>} Final task projection, or the failure payload.
 */
async function rebootOnu(args, fetchImpl, clock) {
    const idempotencyKey = requireIdempotencyKey(args);
    const subscriberId = await resolveSubscriberId(fetchImpl, args);

    return onuAction(fetchImpl, clock, subscriberId, idempotencyKey, 'onu.reboot', {});
}

/**
 * `set_onu_catv` — `onu.catv_update` through `POST /subscribers/{id}/onu/actions`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @return {Promise<object>} Final task projection, or the failure payload.
 */
async function setOnuCatv(args, fetchImpl, clock) {
    const idempotencyKey = requireIdempotencyKey(args);

    if (!['enable', 'disable'].includes(args.catv_state)) {
        fail(invalid('catv_state must be enable or disable.'));
    }

    const subscriberId = await resolveSubscriberId(fetchImpl, args);

    return onuAction(fetchImpl, clock, subscriberId, idempotencyKey, 'onu.catv_update', { catv_state: args.catv_state });
}

/**
 * `change_subscriber_wifi` — reads the ONU WiFi, then writes one SSID based on that read.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @return {Promise<object>} Final task projection of the write, or the failure payload.
 */
async function changeSubscriberWifi(args, fetchImpl, clock) {
    const idempotencyKey = requireIdempotencyKey(args);
    const ssidIndex = asPositiveInt(args.ssid_index);

    if (ssidIndex === null || ssidIndex > 8) {
        fail(invalid('ssid_index must be an integer between 1 and 8.'));
    }

    const subscriberId = await resolveSubscriberId(fetchImpl, args);
    const read = await requireWifiRead(fetchImpl, clock, subscriberId);
    const current = (Array.isArray(read.result?.ssids) ? read.result.ssids : []).find((row) => row?.index === ssidIndex) ?? {};
    const parameters = { ssid_index: ssidIndex };

    for (const field of WIFI_SSID_FIELDS) {
        const value = args[field] ?? current[field];

        if (value === undefined || value === null) {
            fail(invalid(`${field} is required: the WiFi read has no SSID ${ssidIndex} to take it from.`));
        }

        parameters[field] = value;
    }

    if (isPresent(args.password)) {
        parameters.password = args.password;
    }

    parameters.based_on_task_run_id = read.task_run_id;

    return onuAction(fetchImpl, clock, subscriberId, idempotencyKey, 'onu.wifi_ssid_update', parameters);
}

/**
 * `change_wifi_radio` — reads the ONU WiFi, then writes one radio based on that read.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @return {Promise<object>} Final task projection of the write, or the failure payload.
 */
async function changeWifiRadio(args, fetchImpl, clock) {
    const idempotencyKey = requireIdempotencyKey(args);
    const radioIndex = asPositiveInt(args.radio_index);
    const channel = typeof args.channel === 'number' ? String(args.channel) : asTrimmedString(args.channel);

    if (radioIndex === null || radioIndex > 2) {
        fail(invalid('radio_index must be 1 or 2.'));
    }

    if (channel === '') {
        fail(invalid('channel is required: auto or a channel number.'));
    }

    const subscriberId = await resolveSubscriberId(fetchImpl, args);
    const read = await requireWifiRead(fetchImpl, clock, subscriberId);
    const parameters = { radio_index: radioIndex, channel };

    for (const field of ['width', 'tx_power', 'radio_enabled']) {
        if (isPresent(args[field])) {
            parameters[field] = args[field];
        }
    }

    parameters.based_on_task_run_id = read.task_run_id;

    return onuAction(fetchImpl, clock, subscriberId, idempotencyKey, 'onu.wifi_radio_update', parameters);
}

/**
 * `sync_onu` — `POST /subscribers/{id}/onu/sync`, then waits for the task.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @return {Promise<object>} Final task projection, or the failure payload.
 */
async function syncOnu(args, fetchImpl, clock) {
    const idempotencyKey = requireIdempotencyKey(args);
    const subscriberId = await resolveSubscriberId(fetchImpl, args);
    const response = await apiRequest(fetchImpl, 'POST', `/subscribers/${subscriberId}/onu/sync`, { body: {}, idempotencyKey });

    return awaitDispatched(fetchImpl, clock, response);
}

/**
 * `change_subscriber_plan` — `POST /subscribers/{id}/plan`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function changeSubscriberPlan(args, fetchImpl) {
    const idempotencyKey = requireIdempotencyKey(args);
    const planId = requireId(args, 'plan_id');
    const subscriberId = await resolveSubscriberId(fetchImpl, args);

    return call(fetchImpl, 'POST', `/subscribers/${subscriberId}/plan`, { body: { plan_id: planId }, idempotencyKey });
}

/**
 * `reconnect_subscriber` — `POST /subscribers/{id}/reconnect`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function reconnectSubscriber(args, fetchImpl) {
    const idempotencyKey = requireIdempotencyKey(args);
    const scope = requireScope(args);
    const subscriberId = await resolveSubscriberId(fetchImpl, args);

    return call(fetchImpl, 'POST', `/subscribers/${subscriberId}/reconnect`, { body: { scope }, idempotencyKey });
}

/**
 * `create_work_order` — `POST /work-orders`; the idempotency key doubles as the order's `external_ref`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function createWorkOrder(args, fetchImpl) {
    const idempotencyKey = requireIdempotencyKey(args);
    const type = asTrimmedString(args.type);
    const title = asTrimmedString(args.title);

    if (idempotencyKey.length > 100) {
        fail(invalid('idempotency_key is reused as the work order external_ref: at most 100 characters.'));
    }

    if (type === '') {
        fail(invalid('type is required: a work order type key such as technical_visit.'));
    }

    if (title === '' || title.length > 160) {
        fail(invalid('title is required (1 to 160 characters).'));
    }

    const subscriberId = await resolveSubscriberId(fetchImpl, args);
    const body = { client_id: subscriberId, type, title, external_ref: idempotencyKey };

    for (const field of ['description', 'priority']) {
        if (asTrimmedString(args[field]) !== '') {
            body[field] = asTrimmedString(args[field]);
        }
    }

    return call(fetchImpl, 'POST', '/work-orders', { body, idempotencyKey });
}

// ─── Tool catalogue ──────────────────────────────────────────────────────────

const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/** Subscriber selector shared by every tool that acts on or about a subscriber. */
const SUBSCRIBER_PROPERTIES = {
    subscriber_id: { type: 'integer', description: 'Subscriber id. Mutually exclusive with subscriber_query.' },
    subscriber_query: {
        type: 'string',
        description: 'Subscriber name or document fragment; must match exactly one subscriber, otherwise the candidates are returned and nothing else happens. Mutually exclusive with subscriber_id.',
    },
};

/** Arguments every write tool requires. */
const WRITE_PROPERTIES = {
    idempotency_key: {
        type: 'string',
        description: 'Replay token (^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$), reused verbatim as the Idempotency-Key header. A new value per action; reuse it only to retry the same action.',
    },
    requested_by: {
        type: 'string',
        description: 'Name of the person who asked for this change (1 to 120 characters). Sent as X-CloudISP-Requested-By and stamped on the audit trail.',
    },
};

/**
 * Declare a read tool.
 *
 * @param {string} name Tool name.
 * @param {string} title Spanish title.
 * @param {string} description Model-facing description.
 * @param {object} properties Input schema properties.
 * @param {Function} handler Tool handler.
 * @param {string[]} [required] Required argument names.
 * @return {object} Catalogue entry.
 */
function readTool(name, title, description, properties, handler, required = []) {
    const inputSchema = { type: 'object', properties };

    if (required.length > 0) {
        inputSchema.required = required;
    }

    if (Object.keys(properties).length === 0) {
        inputSchema.additionalProperties = false;
    }

    return { name, title, annotations: READ_ANNOTATIONS, description, inputSchema, handler };
}

/**
 * Declare a write tool: hidden without `CLOUDISP_ALLOW_WRITES=1`, `requested_by` and `idempotency_key` required.
 *
 * @param {string} name Tool name.
 * @param {string} title Spanish title.
 * @param {string} description Model-facing description (the write prefix is added).
 * @param {object} properties Input schema properties.
 * @param {string[]} required Required argument names besides the write arguments.
 * @param {Function} handler Tool handler.
 * @param {boolean} [destructive] Whether the write is destructive (disconnect, reconnect, profile swap).
 * @return {object} Catalogue entry.
 */
function writeTool(name, title, description, properties, required, handler, destructive = false) {
    return {
        name,
        title,
        write: true,
        annotations: { readOnlyHint: false, destructiveHint: destructive, idempotentHint: true, openWorldHint: true },
        description: WRITE_PREFIX + description,
        inputSchema: {
            type: 'object',
            properties: { ...WRITE_PROPERTIES, ...properties },
            required: ['idempotency_key', 'requested_by', ...required],
        },
        handler,
    };
}

const TOOLS = [
    readTool(
        'cloudisp_context',
        'Contexto del agente',
        'Rules and knowledge-base articles for the credential platform and its child platforms, plus each platform\'s mode '
        + '(read or technician) and daily write limit. Call it first in every conversation and before delegating; obey the rules and articles it returns.',
        {},
        cloudispContext,
    ),
    readTool(
        'search_knowledge',
        'Buscar en la base de conocimiento',
        'Search the knowledge base of the visible platforms by text (2 to 100 characters; results carry a 300-character snippet), '
        + 'or fetch one article in full with article_id.',
        {
            query: { type: 'string', description: 'Text to search in titles and bodies. Mutually exclusive with article_id.' },
            article_id: { type: 'integer', description: 'Article id from a previous search. Mutually exclusive with query.' },
        },
        searchKnowledge,
    ),
    readTool(
        'find_subscriber',
        'Buscar abonado',
        'Find subscribers by name or document fragment (at least 2 characters). Read the meta.total field: a write '
        + 'tool that needs a single subscriber refuses to act when it is not 1.',
        { query: { type: 'string', description: 'Name (first/last) or document fragment, at least 2 characters.' } },
        findSubscriber,
        ['query'],
    ),
    readTool(
        'get_subscriber',
        'Ver abonado',
        'Fetch one subscriber by subscriber_id or by subscriber_query (exactly one match required).',
        SUBSCRIBER_PROPERTIES,
        getSubscriber,
    ),
    readTool(
        'diagnose_subscriber',
        'Diagnosticar abonado',
        'One-call diagnosis of a subscriber: subscriber, billing (open_cutoff, overdue_invoices, outstanding_cents), onu (state and last '
        + 'optical reading), network_context (PPPoE session, last 24 h), consumption, activity and open work orders. A section that cannot be built '
        + 'is null and listed in section_errors; null means "no disponible", never 0.',
        SUBSCRIBER_PROPERTIES,
        diagnoseSubscriber,
    ),
    readTool(
        'onu_read',
        'Leer ONU',
        'Read the subscriber\'s ONU through a device task and wait up to 40 s for the result. It does not change the equipment. Returns the '
        + 'final task projection ({success, status, task_run_id, error_code, message, result}); when the task is still running it returns '
        + '{status: "pending", task_run_id}: follow it with get_task. Operations: olt.onu_details_read, olt.onu_health_check, onu.tr069_read '
        + '(parameters {refresh: boolean}), onu.wan_read, onu.wifi_read, onu.catv_read, onu.wifi_diagnose.',
        {
            ...SUBSCRIBER_PROPERTIES,
            operation: { type: 'string', enum: ONU_READ_OPERATIONS, description: 'ONU read operation.' },
            parameters: { type: 'object', description: 'Operation parameters; only onu.tr069_read takes one ({refresh: boolean}).' },
        },
        onuRead,
        ['operation'],
    ),
    readTool(
        'onu_diagnose',
        'Diagnosticar ONU',
        'Diagnose the subscriber\'s ONU ("Diagnosticar ONU": sync in observe-only mode): compares the OLT/ONU with the expected provisioning and reports '
        + 'gaps without changing anything. Waits up to 40 s like onu_read. sync_template_missing means the model has no sync template ("modelo no adaptado").',
        SUBSCRIBER_PROPERTIES,
        onuDiagnose,
    ),
    readTool(
        'get_task',
        'Estado de una tarea',
        'Current status of a device task (task_run_id from onu_read, olt_read, router_read or an ONU write): status pending, running, succeeded, failed or canceled, plus the safe result.',
        { task_run_id: { type: 'integer', description: 'Task run id.' } },
        getTask,
        ['task_run_id'],
    ),
    readTool(
        'list_onus',
        'Listar ONUs',
        'List ONUs of the visible platforms, optionally filtered by state (online, offline, los, absent...), subscriber, OLT or PON. Each row carries '
        + 'olt, pon_slot, pon_port, state, client_id and last_seen_at. meta.total is the full count: use per_page=1 to only count.',
        {
            state: { type: 'string', description: 'ONU state filter, e.g. online, offline, los.' },
            ...SUBSCRIBER_PROPERTIES,
            olt_id: { type: 'integer', description: 'Only ONUs of this OLT.' },
            pon_slot: { type: 'integer', description: 'Only ONUs of this PON slot (combine with olt_id and pon_port).' },
            pon_port: { type: 'integer', description: 'Only ONUs of this PON port (combine with olt_id and pon_slot).' },
            page: { type: 'integer', description: 'Page number, from 1.' },
            per_page: { type: 'integer', description: 'Rows per page (API maximum 100).' },
        },
        listOnus,
    ),
    readTool(
        'list_olts',
        'Listar OLTs',
        'List the OLTs of the visible platforms with model, status and last poll. Credentials are never exposed.',
        {},
        listOlts,
    ),
    readTool(
        'get_olt',
        'Ver OLT',
        'One OLT with its PON summary: per slot/port total, online, offline and worst_rx_dbm.',
        { olt_id: { type: 'integer', description: 'OLT id from list_olts.' } },
        getOlt,
        ['olt_id'],
    ),
    readTool(
        'olt_read',
        'Leer OLT',
        'Run a read-only operation on an OLT through a device task and wait up to 40 s for the result (see onu_read for the result shape). '
        + 'Operations: olt.health_check, olt.system_info_read, olt.mac_table_read, olt.unprovisioned_onus_read, olt.poll; the API refuses those it has not enabled.',
        {
            olt_id: { type: 'integer', description: 'OLT id from list_olts.' },
            operation: { type: 'string', enum: OLT_READ_OPERATIONS, description: 'OLT read operation.' },
            parameters: { type: 'object', description: 'Operation parameters, when the operation takes any.' },
        },
        oltRead,
        ['olt_id', 'operation'],
    ),
    readTool(
        'list_routers',
        'Listar routers',
        'List the MikroTik routers of the visible platforms with a health summary. Host credentials are never exposed.',
        {},
        listRouters,
    ),
    readTool(
        'router_read',
        'Leer router',
        'Run a read-only operation on a MikroTik router through a device task and wait up to 40 s for the result (see onu_read for the result shape). '
        + 'Operations: routeros.health_check; routeros.test_command (requires command, one of /system/identity/print, /system/resource/print, /interface/print, /ip/address/print); '
        + 'routeros.interface_monitor_traffic (parameters {interface}). Resource, interface, PPP, ARP and DHCP reads are not available: use list_routers, device_metrics or platform_logs instead.',
        {
            router_id: { type: 'integer', description: 'Router id from list_routers.' },
            operation: { type: 'string', enum: ROUTER_READ_OPERATIONS, description: 'Router read operation.' },
            command: { type: 'string', enum: ROUTER_TEST_COMMANDS, description: 'Required for routeros.test_command.' },
            parameters: { type: 'object', description: 'Operation parameters, when the operation takes any.' },
        },
        routerRead,
        ['router_id', 'operation'],
    ),
    readTool(
        'network_alerts',
        'Alertas de red',
        'Recent network alerts of the visible platforms.',
        { limit: { type: 'integer', description: 'Maximum alerts to return.' } },
        networkAlerts,
    ),
    readTool(
        'device_metrics',
        'Métricas de dispositivo',
        'Metrics of a router or OLT. Without metric_ids it returns the metric catalogue of the device; with metric_ids it returns their time series.',
        {
            kind: { type: 'string', enum: DEVICE_KINDS, description: 'Device kind.' },
            device_id: { type: 'integer', description: 'Router or OLT id.' },
            metric_ids: { type: 'array', items: { type: 'string' }, description: 'Metric ids from the catalogue. Omit to get the catalogue.' },
            window: { type: 'string', description: 'Time window of the series, e.g. 1h, 24h.' },
            resolution: { type: 'string', description: 'Series resolution.' },
        },
        deviceMetrics,
        ['kind', 'device_id'],
    ),
    readTool(
        'platform_logs',
        'Logs de plataforma',
        'Syslog/event logs of one platform (router and OLT events). The range is at most 7 days and limit at most 500.',
        {
            platform_id: { type: 'integer', description: 'Platform id (2, 3, 4 or 15 for NVS).' },
            since: { type: 'string', description: 'Start of the range (ISO 8601).' },
            until: { type: 'string', description: 'End of the range (ISO 8601).' },
            kind: { type: 'string', description: 'Event kind filter.' },
            device_kind: { type: 'string', description: 'Device kind filter (routeros or olt).' },
            device_id: { type: 'integer', description: 'Device id filter.' },
            severity: { type: 'array', items: { type: 'string' }, description: 'Severity filter.' },
            q: { type: 'string', description: 'Text to search, e.g. a PPPoE user.' },
            limit: { type: 'integer', description: 'Maximum events (at most 500).' },
        },
        platformLogs,
        ['platform_id'],
    ),
    readTool(
        'list_reports',
        'Listar reportes',
        'Catalogue of the reports the API can run, with their declared filters.',
        {},
        listReports,
    ),
    readTool(
        'run_report',
        'Ejecutar reporte',
        'Run one report from list_reports across the visible platforms (or one platform_id) and return its result.',
        {
            key: { type: 'string', description: 'Report key from list_reports.' },
            platform_id: { type: 'integer', description: 'Restrict the report to one visible platform.' },
            filters: { type: 'object', description: 'The report\'s declared filters as name/value pairs.' },
        },
        runReport,
        ['key'],
    ),
    readTool(
        'list_internet_profiles',
        'Listar perfiles de internet',
        'List the active internet profiles of the credential platform with their id, name, download_max_limit and '
        + 'upload_max_limit. Use profile_id from here for change_subscriber_bandwidth.',
        {},
        listInternetProfiles,
    ),
    readTool(
        'list_plans',
        'Listar planes',
        'List commercial plans of the visible platforms. Use plan_id from here for change_subscriber_plan.',
        {
            status: { type: 'string', description: 'Plan status filter, e.g. active.' },
            page: { type: 'integer', description: 'Page number, from 1.' },
            per_page: { type: 'integer', description: 'Rows per page (default and API maximum 100).' },
        },
        listPlans,
    ),
    readTool(
        'list_invoices',
        'Listar facturas',
        'List invoices, optionally of one subscriber and status. Payment does not change status: remaining debt is balance_cents.',
        {
            ...SUBSCRIBER_PROPERTIES,
            status: { type: 'string', description: 'Invoice status filter.' },
            page: { type: 'integer', description: 'Page number, from 1.' },
            per_page: { type: 'integer', description: 'Rows per page (API maximum 100).' },
        },
        listInvoices,
    ),
    readTool(
        'find_work_orders',
        'Buscar órdenes de trabajo',
        'List work orders, optionally of one subscriber (subscriber_id, or a subscriber_query that matches exactly one subscriber, otherwise '
        + 'the candidates are returned and nothing is listed), plus optional type and status.',
        {
            ...SUBSCRIBER_PROPERTIES,
            type: { type: 'string', description: 'Work order type filter, e.g. installation, technical_visit.' },
            status: { type: 'string', description: 'Work order status filter, e.g. pending, in_progress, completed, cancelled.' },
            page: { type: 'integer', description: 'Page number, from 1.' },
            per_page: { type: 'integer', description: 'Rows per page (API maximum 100).' },
        },
        findWorkOrders,
    ),
    readTool(
        'get_work_order',
        'Ver orden de trabajo',
        'Fetch one work order by id.',
        { work_order_id: { type: 'integer', description: 'Work order id.' } },
        getWorkOrder,
        ['work_order_id'],
    ),
    readTool(
        'find_technician',
        'Buscar técnico',
        'Find active employees by name fragment. Use employee_id from the single result for assign_work_order.',
        { query: { type: 'string', description: 'Employee name fragment.' } },
        findTechnician,
        ['query'],
    ),
    readTool(
        'network_snapshot',
        'Estado de red',
        'Latest online PPP session count and WAN throughput in Mbps for the credential platform, plus their collection '
        + 'timestamps. This is not a 24-hour consumption report and not a saturation percentage; usage_24h.available is '
        + 'always false because RADIUS accounting is not exposed.',
        {},
        networkSnapshot,
    ),
    writeTool(
        'reboot_onu',
        'Reiniciar ONU',
        'Reboot the subscriber\'s ONU. The subscriber loses service for a few minutes. Waits up to 40 s and returns the task projection; if it failed, '
        + 'offer a technical-visit work order (create_work_order).',
        SUBSCRIBER_PROPERTIES,
        [],
        rebootOnu,
    ),
    writeTool(
        'set_onu_catv',
        'CATV de la ONU',
        'Enable or disable the CATV output of the subscriber\'s ONU. Waits up to 40 s and returns the task projection.',
        {
            ...SUBSCRIBER_PROPERTIES,
            catv_state: { type: 'string', enum: ['enable', 'disable'], description: 'Target CATV state.' },
        },
        ['catv_state'],
        setOnuCatv,
    ),
    writeTool(
        'change_subscriber_wifi',
        'Cambiar WiFi',
        'Change one WiFi network (SSID) of the subscriber\'s ONU. It first reads the ONU WiFi (onu.wifi_read, up to 40 s) and writes based on that read; '
        + 'enabled, name, hidden, auth_mode and encrypt_type you omit are taken from the read, because the write carries the whole desired state. '
        + 'password is optional (8 to 63 characters, no spaces, quotes, backslashes or "?") and is never echoed. Waits up to 40 s for the write and returns its task projection.',
        {
            ...SUBSCRIBER_PROPERTIES,
            ssid_index: { type: 'integer', description: 'SSID slot, 1 to 8, as reported by onu_read onu.wifi_read.' },
            enabled: { type: 'boolean', description: 'Whether the network is on.' },
            name: { type: 'string', description: 'Network name (SSID).' },
            hidden: { type: 'boolean', description: 'Whether the SSID is hidden.' },
            auth_mode: { type: 'string', enum: ['wpa2psk', 'wpapsk/wpa2psk', 'wpa3psk'], description: 'Authentication mode.' },
            encrypt_type: { type: 'string', enum: ['aes', 'tkipaes'], description: 'Encryption.' },
            password: { type: 'string', description: 'New WiFi password; omit to keep the current one.' },
        },
        ['ssid_index'],
        changeSubscriberWifi,
    ),
    writeTool(
        'change_wifi_radio',
        'Cambiar canal WiFi',
        'Change one WiFi radio (channel, width, power) of the subscriber\'s ONU. It first reads the ONU WiFi (onu.wifi_read, up to 40 s) and writes based on that read. '
        + 'Waits up to 40 s for the write and returns its task projection.',
        {
            ...SUBSCRIBER_PROPERTIES,
            radio_index: { type: 'integer', description: 'Radio, 1 or 2, as reported by onu_read onu.wifi_read.' },
            channel: { type: 'string', description: 'auto, or a channel number valid for the radio band (1-13 on 2.4 GHz; 36-64, 100-140, 149-165 on 5 GHz).' },
            width: { type: 'string', enum: ['keep', 'auto', '20MHz', '40MHz', '80MHz', '160MHz'], description: 'Channel width; keep (default) leaves it.' },
            tx_power: { type: 'integer', description: 'Transmit power 1-100 percent; 0 (default) leaves it.' },
            radio_enabled: { type: 'string', enum: ['keep', 'on', 'off'], description: 'Radio on/off; keep (default) leaves it.' },
        },
        ['radio_index', 'channel'],
        changeWifiRadio,
    ),
    writeTool(
        'sync_onu',
        'Sincronizar ONU',
        'Sync (re-provision) the subscriber\'s linked ONU with its expected configuration. Run onu_diagnose first and offer this only when it detects a missing or wrong '
        + 'channel. Waits up to 40 s and returns the task projection; sync_template_missing means the model is not adapted.',
        SUBSCRIBER_PROPERTIES,
        [],
        syncOnu,
    ),
    writeTool(
        'change_subscriber_plan',
        'Cambiar plan',
        'Change the subscriber\'s commercial plan (plan_id from list_plans). It changes what the subscriber is billed and the internet profile.',
        {
            ...SUBSCRIBER_PROPERTIES,
            plan_id: { type: 'integer', description: 'Target plan id from list_plans.' },
        },
        ['plan_id'],
        changeSubscriberPlan,
    ),
    writeTool(
        'change_subscriber_bandwidth',
        'Cambiar perfil de abonado',
        'Swap a subscriber to an existing internet profile, either by profile_id or by exact download_max_limit. '
        + 'Resolves a text query only when it matches exactly one subscriber. The change is queued to the provider; '
        + 'the live RADIUS session is not updated here.',
        {
            ...SUBSCRIBER_PROPERTIES,
            profile_id: { type: 'integer', description: 'Target internet profile id. Mutually exclusive with download_max_limit.' },
            download_max_limit: { type: 'integer', description: 'Exact download_max_limit of the target profile. Mutually exclusive with profile_id.' },
        },
        [],
        changeSubscriberBandwidth,
        true,
    ),
    writeTool(
        'disconnect_subscriber',
        'Desconectar abonado',
        'Disconnect a subscriber (active -> disconnected): the service is cut. Resolves a text query only when it matches exactly one '
        + 'subscriber. Optionally opens a linked work order using the same idempotency_key as external_ref; the work order is only opened '
        + 'when the disconnect is accepted.',
        {
            ...SUBSCRIBER_PROPERTIES,
            scope: { type: 'string', enum: SERVICE_SCOPES, description: 'Service to cut: internet (default), catv or all.' },
            open_work_order: { type: 'boolean', description: 'Open a linked work order after a successful disconnect. Defaults to false.' },
            work_order_type: { type: 'string', description: 'Work order type for the linked order. Defaults to technical_service.', default: 'technical_service' },
            work_order_title: { type: 'string', description: 'Work order title. Defaults to "Desconexión de abonado {id}".' },
        },
        [],
        disconnectSubscriber,
        true,
    ),
    writeTool(
        'reconnect_subscriber',
        'Reconectar abonado',
        'Reconnect a subscriber (disconnected -> active): the service is restored. Refused with illegal_transition (and the availability) '
        + 'when the reconnection is not available, e.g. an open debt cutoff.',
        {
            ...SUBSCRIBER_PROPERTIES,
            scope: { type: 'string', enum: SERVICE_SCOPES, description: 'Service to restore: internet (default), catv or all.' },
        },
        [],
        reconnectSubscriber,
        true,
    ),
    writeTool(
        'create_work_order',
        'Crear orden de trabajo',
        'Create a work order for a subscriber. The idempotency_key is also stored as the order\'s external_ref (at most 100 characters). '
        + 'For a failed ONU reboot use type technical_visit.',
        {
            ...SUBSCRIBER_PROPERTIES,
            type: { type: 'string', description: 'Work order type key, e.g. installation, technical_visit, technical_service, reconnection.' },
            title: { type: 'string', description: 'Order title, 1 to 160 characters.' },
            description: { type: 'string', description: 'Order description, up to 2000 characters.' },
            priority: { type: 'string', description: 'Order priority key; defaults to medium.' },
        },
        ['type', 'title'],
        createWorkOrder,
    ),
    writeTool(
        'assign_work_order',
        'Asignar orden de trabajo',
        'Assign a pending work order to a technician. Resolve the order either by work_order_id or by a subscriber (subscriber_id / subscriber_query) plus type, which '
        + 'must yield exactly one pending order of that type, and the technician either by employee_id or by a name query that must match exactly one active '
        + 'employee. Ambiguous lookups return their candidates and do not assign.',
        {
            work_order_id: { type: 'integer', description: 'Work order id. Mutually exclusive with subscriber_id / subscriber_query.' },
            ...SUBSCRIBER_PROPERTIES,
            type: { type: 'string', description: 'Work order type of the pending order to assign; required with a subscriber.' },
            employee_id: { type: 'integer', description: 'Technician employee id. Mutually exclusive with technician_query.' },
            technician_query: { type: 'string', description: 'Technician name fragment. Mutually exclusive with employee_id.' },
        },
        [],
        assignWorkOrder,
    ),
];

/** Tools that change state; hidden and refused unless `CLOUDISP_ALLOW_WRITES=1`. */
const WRITE_TOOLS = TOOLS.filter((tool) => tool.write).map((tool) => tool.name);

/**
 * Return the MCP tool catalogue without the internal handlers, hiding the write
 * tools while the write guardrail is on.
 *
 * @param {Record<string, string|undefined>} [env] Environment bag (defaults to `process.env`).
 * @return {Array<object>}
 */
export function listTools(env = process.env) {
    const enabled = writesEnabled(env);

    return TOOLS
        .filter((tool) => enabled || !WRITE_TOOLS.includes(tool.name))
        .map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
}

// ─── Outcomes ────────────────────────────────────────────────────────────────

/** Short Spanish instruction to the model per outcome; anything else gets {@link DEFAULT_HINT}. */
const DEFAULT_HINT = 'Informalo al usuario; no reintentes.';
const OUTCOME_HINTS = {
    not_found: 'Dato no disponible: decilo así.',
    task_not_found: 'Dato no disponible: decilo así.',
    source_unavailable: 'Dato no disponible: decilo así.',
    validation_failed: 'Argumentos inválidos: corregilos o preguntale al usuario; no repitas la misma llamada.',
    wifi_read_pending: 'La lectura no terminó y no se escribió nada; consultá get_task más tarde.',
    task_failed: 'La tarea falló en el equipo: informá el motivo y ofrecé la alternativa (reinicio u OT); no reintentes solo.',
};

/**
 * Build the outcome shape: an expected answer, not a tool error (no top-level `error` key).
 *
 * @param {string} outcome Machine code.
 * @param {unknown} message Human-readable reason.
 * @param {unknown} [details] API details or candidates.
 * @param {object} [extra] Extra fields (e.g. `error_code`).
 * @return {object}
 */
function outcomeResult(outcome, message, details, extra = {}) {
    const hint = OUTCOME_HINTS[outcome] ?? (outcome.startsWith('ambiguous_')
        ? 'Mostrale los candidatos al usuario con clarify y que elija; no adivines.'
        : DEFAULT_HINT);

    return {
        ok: false,
        outcome,
        ...extra,
        message: typeof message === 'string' ? message : '',
        ...(details === undefined || details === null ? {} : { details }),
        hint,
    };
}

/**
 * Turn expected domain answers into outcomes so they do not count as tool errors.
 *
 * Outcomes: HTTP 4xx (except 401) and 503 `source_unavailable` carrying an API error code, the
 * MCP's own refusals (validation, ambiguity, writes disabled, WiFi read pending) and failed device
 * tasks. Transport failures, 401, other 5xx, non-JSON answers and unknown tools stay errors.
 *
 * @param {unknown} result Raw tool payload.
 * @return {unknown} The payload, or its outcome form.
 */
function classifyOutcome(result) {
    if (!isPlainObject(result)) {
        return result;
    }

    const status = result[HTTP_STATUS];

    if (isPlainObject(result.error)) {
        const { code, message, details } = result.error;
        const expected = typeof code === 'string' && code !== 'http_error' && code !== 'unauthorized' && status !== 401
            && ((status >= 400 && status < 500) || (status === 503 && code === 'source_unavailable'));

        return expected ? outcomeResult(code, message, details) : result;
    }

    if (typeof result.error === 'string') {
        return result.error === 'unknown_tool' ? result : outcomeResult(result.error, result.message, result.candidates);
    }

    if (result.success === false && (result.status === 'failed' || result.status === 'canceled')) {
        return outcomeResult('task_failed', result.error_message || result.message, undefined, {
            error_code: result.error_code ?? null,
            ...(result.replayed === undefined ? {} : { replayed: result.replayed }),
        });
    }

    return result;
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Execute one tool call and return its JSON-serializable result.
 *
 * Never throws for tool-level failures: validation, ambiguity, transport and API
 * errors all come back as an object, so the MCP layer can mark `isError`.
 *
 * @param {string} name Tool name.
 * @param {object} args Tool arguments.
 * @param {Function} [fetchImpl] `fetch`-compatible implementation (defaults to the global `fetch`).
 * @param {Record<string, string|undefined>} [env] Environment bag (defaults to `process.env`).
 * @param {{ now: Function, sleep: Function }} [clock] Clock seams for task polling (defaults to real timers).
 * @return {Promise<object>} Tool result payload.
 */
export async function dispatch(name, args, fetchImpl = globalThis.fetch, env = process.env, clock = REAL_CLOCK) {
    return classifyOutcome(await dispatchRaw(name, args, fetchImpl, env, clock));
}

/**
 * Run a tool and return its raw payload (API envelope, refusal or failure), before outcome classification.
 *
 * @param {string} name Tool name.
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {Record<string, string|undefined>} env Environment bag.
 * @param {{ now: Function, sleep: Function }} clock Clock seams.
 * @return {Promise<object>} Raw tool payload.
 */
async function dispatchRaw(name, args, fetchImpl, env, clock) {
    const tool = TOOLS.find((candidate) => candidate.name === name);

    if (!tool) {
        return { error: 'unknown_tool', message: `Unknown tool: ${String(name)}` };
    }

    if (!writesEnabled(env) && WRITE_TOOLS.includes(name)) {
        return { error: 'writes_disabled', message: WRITES_DISABLED_MESSAGE };
    }

    if (!isPlainObject(args)) {
        return invalid('arguments must be an object.');
    }

    try {
        const http = tool.write ? withRequestedBy(fetchImpl, requireRequestedBy(args)) : fetchImpl;

        return await tool.handler(args, http, clock);
    } catch (error) {
        if (error instanceof ToolError) {
            return error.payload;
        }

        throw error;
    }
}

// ─── JSON-RPC / framing ──────────────────────────────────────────────────────

/**
 * Encode one JSON-RPC message as a newline-terminated JSON line.
 *
 * @param {object} payload JSON-RPC message.
 * @return {string}
 */
function encodeMessage(payload) {
    return `${JSON.stringify(payload)}\n`;
}

/**
 * @param {unknown} id Request id.
 * @param {object} result Result payload.
 * @return {object} JSON-RPC result message.
 */
function resultMessage(id, result) {
    return { jsonrpc: '2.0', id, result };
}

/**
 * @param {unknown} id Request id.
 * @param {number} code JSON-RPC error code.
 * @param {string} message Error message.
 * @return {object} JSON-RPC error message.
 */
function errorMessage(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Create a stateful newline-delimited JSON reader.
 *
 * Blank/whitespace-only lines are ignored; a `\r` left by CRLF input is stripped.
 *
 * @return {function(Buffer|string): Array<{ message: object|null, parseError: boolean }>} Feed a chunk,
 *     receive every complete line it completed, each marked as parsed or malformed.
 */
function createLineReader() {
    let buffer = '';

    return (chunk) => {
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        const entries = [];

        for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, '').trim();

            if (line === '') {
                continue;
            }

            try {
                entries.push({ message: JSON.parse(line), parseError: false });
            } catch {
                entries.push({ message: null, parseError: true });
            }
        }

        return entries;
    };
}

/** Personal-data keys stripped from every tool result before it reaches the model. */
export const REDACTED_KEYS = new Set(['document', 'phone', 'email', 'password', 'psk', 'wifi_password']);

/**
 * Wrap a tool result as an MCP `tools/call` result.
 *
 * @param {unknown} result Tool result payload.
 * @return {object}
 */
function toolCallResult(result) {
    const text = JSON.stringify(result, (key, value) => (REDACTED_KEYS.has(key) ? undefined : value), 2);
    // A task still `pending`/`running` carries `success: false` but is not a failure.
    const unfinished = result?.status === 'pending' || result?.status === 'running';
    const isError = isPlainObject(result) && (typeof result.error === 'string' || (result.success === false && !unfinished));

    return { content: [{ type: 'text', text }], isError };
}

/**
 * Handle one decoded JSON-RPC message.
 *
 * @param {object} message JSON-RPC message.
 * @param {function(object, Function=): void} send Line writer, optional flush callback.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {Record<string, string|undefined>} [env] Environment bag (defaults to `process.env`).
 * @return {Promise<'ok'|'fatal'>} `fatal` asks the caller to stop and exit 1.
 */
async function handleMessage(message, send, fetchImpl, env = process.env) {
    if (!isPlainObject(message) || typeof message.method !== 'string') {
        return 'ok';
    }

    // Notifications (initialized, cancelled, ...) are never answered.
    if (message.method.startsWith('notifications/') || message.id === undefined || message.id === null) {
        return 'ok';
    }

    const { id, method, params } = message;

    switch (method) {
        case 'initialize': {
            const config = readConfig();

            if (!config.configured) {
                send(
                    errorMessage(
                        id,
                        -32000,
                        'CLOUDISP_API_BASE and CLOUDISP_API_KEY must be set in the server environment.',
                    ),
                    () => process.exit(1),
                );

                return 'fatal';
            }

            if (!config.valid) {
                send(
                    errorMessage(id, -32000, 'CLOUDISP_API_BASE must be an https:// URL (http:// allowed only for localhost).'),
                    () => process.exit(1),
                );

                return 'fatal';
            }

            send(
                resultMessage(id, {
                    protocolVersion: typeof params?.protocolVersion === 'string'
                        ? params.protocolVersion
                        : DEFAULT_PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
                    instructions: INSTRUCTIONS,
                }),
            );

            return 'ok';
        }

        case 'ping':
            send(resultMessage(id, {}));

            return 'ok';

        case 'tools/list':
            send(resultMessage(id, { tools: listTools(env) }));

            return 'ok';

        case 'tools/call': {
            const name = params?.name;
            const args = isPlainObject(params?.arguments) ? params.arguments : {};

            try {
                send(resultMessage(id, toolCallResult(await dispatch(name, args, fetchImpl, env))));
            } catch (error) {
                send(
                    resultMessage(id, toolCallResult(error?.name === 'TimeoutError'
                        ? { error: 'timeout', message: 'CloudISP API did not answer within 30 s.' }
                        : { error: 'transport_failed', message: String(error?.message ?? error) })),
                );
            }

            return 'ok';
        }

        default:
            send(errorMessage(id, -32601, `Method not found: ${method}`));

            return 'ok';
    }
}

/**
 * Start the stdio server loop.
 *
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, fetchImpl?: Function,
 *     env?: Record<string, string|undefined> }} [options] Test seams.
 * @return {void}
 */
export function startServer(options = {}) {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const env = options.env ?? process.env;

    const readLines = createLineReader();

    /**
     * @param {object} payload JSON-RPC message.
     * @param {Function} [done] Flush callback.
     */
    const send = (payload, done) => {
        const text = encodeMessage(payload);

        if (done) {
            output.write(text, done);
        } else {
            output.write(text);
        }
    };

    input.on('data', (chunk) => {
        for (const entry of readLines(chunk)) {
            if (entry.parseError) {
                send(errorMessage(null, -32700, 'Parse error: invalid JSON.'));
                continue;
            }

            handleMessage(entry.message, send, fetchImpl, env).catch(() => {
                send(errorMessage(entry.message?.id ?? null, -32603, 'Internal error.'));
            });
        }
    });
}

const invokedDirectly = process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
    startServer();
}
