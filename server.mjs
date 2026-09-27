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
const SERVER_VERSION = '0.2.1';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const API_PREFIX = '/api/v1/public';
const REQUEST_TIMEOUT_MS = 30000;

/** Hint handed to the client during `initialize`. */
const INSTRUCTIONS = 'CloudISP operator tools. Resolve people by search before acting; never guess ids; '
    + "report missing data as 'no disponible'; writes require CLOUDISP_ALLOW_WRITES=1.";

/** Tools that change state; hidden and refused unless `CLOUDISP_ALLOW_WRITES=1`. */
const WRITE_TOOLS = ['change_subscriber_bandwidth', 'disconnect_subscriber', 'assign_installation'];

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
    if (response.body !== null && response.body !== undefined) {
        return response.body;
    }

    return {
        success: false,
        error: { code: 'http_error', message: `The public API answered HTTP ${response.status} with no JSON body.` },
    };
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
        if (value !== undefined && value !== null && value !== '') {
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
 * Resolve exactly one of `subscriber_id` or `query` to a subscriber id.
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} args Tool arguments.
 * @param {string} [queryKey] Argument carrying the lookup query (defaults to `query`).
 * @return {Promise<number>} The subscriber id.
 */
async function resolveSubscriberId(fetchImpl, args, queryKey = 'query') {
    const hasId = isPresent(args.subscriber_id);
    const query = asTrimmedString(args[queryKey]);

    if (hasId === (query !== '')) {
        fail(invalid('Provide exactly one of subscriber_id or query.'));
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
 * Resolve one pending installation work order for a subscriber query.
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {string} subscriberQuery Subscriber name or document fragment.
 * @return {Promise<object>} The single pending installation work order.
 */
async function findPendingInstallation(fetchImpl, subscriberQuery) {
    const subscriber = await findSingleSubscriber(fetchImpl, subscriberQuery);
    const response = await apiRequest(fetchImpl, 'GET', '/work-orders', {
        query: { client_id: subscriber.id, type: 'installation', status: 'pending' },
    });

    if (!response.ok) {
        fail(apiFailurePayload(response));
    }

    const rows = Array.isArray(response.body?.data) ? response.body.data : [];

    if (response.body?.meta?.total !== 1 || rows.length !== 1) {
        fail({ error: 'ambiguous_installation', candidates: rows });
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
    const subscriberId = await resolveSubscriberId(fetchImpl, args);

    const response = await apiRequest(fetchImpl, 'POST', `/subscribers/${subscriberId}/disconnect`, { idempotencyKey });

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
 * `find_work_orders` — optional `client_id` or subscriber `query`, optional `type`/`status`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function findWorkOrders(args, fetchImpl) {
    const hasClientId = isPresent(args.client_id);
    const query = asTrimmedString(args.query);

    if (hasClientId && query !== '') {
        fail(invalid('Provide at most one of client_id or query.'));
    }

    let clientId = null;
    if (hasClientId) {
        clientId = asPositiveInt(args.client_id);

        if (clientId === null) {
            fail(invalid('client_id must be a positive integer.'));
        }
    } else if (query !== '') {
        clientId = (await findSingleSubscriber(fetchImpl, query)).id;
    }

    const type = asTrimmedString(args.type);
    const status = asTrimmedString(args.status);
    const response = await apiRequest(fetchImpl, 'GET', '/work-orders', {
        query: { client_id: clientId, type, status },
    });

    return isFailure(response) ? apiFailurePayload(response) : response.body;
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
 * `assign_installation` — resolves one pending installation and one technician, then
 * `POST /work-orders/{id}/assign`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function assignInstallation(args, fetchImpl) {
    const hasWorkOrderId = isPresent(args.work_order_id);
    const subscriberQuery = asTrimmedString(args.subscriber_query);

    if (hasWorkOrderId === (subscriberQuery !== '')) {
        fail(invalid('Provide exactly one of work_order_id or subscriber_query.'));
    }

    const hasEmployeeId = isPresent(args.employee_id);
    const technicianQuery = asTrimmedString(args.technician_query);

    if (hasEmployeeId === (technicianQuery !== '')) {
        fail(invalid('Provide exactly one of employee_id or technician_query.'));
    }

    let workOrderId;
    if (hasWorkOrderId) {
        workOrderId = asPositiveInt(args.work_order_id);

        if (workOrderId === null) {
            fail(invalid('work_order_id must be a positive integer.'));
        }
    } else {
        workOrderId = (await findPendingInstallation(fetchImpl, subscriberQuery)).id;
    }

    let employeeId;
    if (hasEmployeeId) {
        employeeId = asPositiveInt(args.employee_id);

        if (employeeId === null) {
            fail(invalid('employee_id must be a positive integer.'));
        }
    } else {
        employeeId = (await findSingleEmployee(fetchImpl, technicianQuery)).id;
    }

    const response = await apiRequest(fetchImpl, 'POST', `/work-orders/${workOrderId}/assign`, {
        body: { employee_id: employeeId },
    });

    return isFailure(response) ? apiFailurePayload(response) : response.body;
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

// ─── Tool catalogue ──────────────────────────────────────────────────────────

const TOOLS = [
    {
        name: 'find_subscriber',
        title: 'Buscar abonado',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description:
            'Find subscribers by name or document fragment (at least 2 characters). Read the meta.total field: a write '
            + 'tool that needs a single subscriber refuses to act when it is not 1.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Name (first/last) or document fragment, at least 2 characters.' },
            },
            required: ['query'],
        },
        handler: findSubscriber,
    },
    {
        name: 'list_internet_profiles',
        title: 'Listar perfiles de internet',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description:
            'List the active internet profiles of the credential platform with their id, name, download_max_limit and '
            + 'upload_max_limit. Use profile_id from here for change_subscriber_bandwidth.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: listInternetProfiles,
    },
    {
        name: 'change_subscriber_bandwidth',
        title: 'Cambiar perfil de abonado',
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        description:
            'Swap a subscriber to an existing internet profile, either by profile_id or by exact download_max_limit. '
            + 'Resolves a text query only when it matches exactly one subscriber. Requires idempotency_key: reuse the '
            + 'same value to replay. The change is queued to the provider; the live RADIUS session is not updated here.',
        inputSchema: {
            type: 'object',
            properties: {
                idempotency_key: { type: 'string', description: 'Replay token, reused verbatim as the Idempotency-Key header.' },
                subscriber_id: { type: 'integer', description: 'Subscriber id. Mutually exclusive with query.' },
                query: { type: 'string', description: 'Subscriber name or document fragment. Mutually exclusive with subscriber_id.' },
                profile_id: { type: 'integer', description: 'Target internet profile id. Mutually exclusive with download_max_limit.' },
                download_max_limit: { type: 'integer', description: 'Exact download_max_limit of the target profile. Mutually exclusive with profile_id.' },
            },
            required: ['idempotency_key'],
        },
        handler: changeSubscriberBandwidth,
    },
    {
        name: 'disconnect_subscriber',
        title: 'Desconectar abonado',
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        description:
            'Disconnect a subscriber (active -> disconnected). Resolves a text query only when it matches exactly one '
            + 'subscriber. Requires idempotency_key: reuse the same value to replay. Optionally opens a linked work order '
            + 'using the same idempotency_key as external_ref; the work order is only opened when the disconnect is accepted.',
        inputSchema: {
            type: 'object',
            properties: {
                idempotency_key: { type: 'string', description: 'Replay token, reused verbatim as the Idempotency-Key header and as the work order external_ref.' },
                subscriber_id: { type: 'integer', description: 'Subscriber id. Mutually exclusive with query.' },
                query: { type: 'string', description: 'Subscriber name or document fragment. Mutually exclusive with subscriber_id.' },
                open_work_order: { type: 'boolean', description: 'Open a linked work order after a successful disconnect. Defaults to false.' },
                work_order_type: { type: 'string', description: 'Work order type for the linked order. Defaults to technical_service.', default: 'technical_service' },
                work_order_title: { type: 'string', description: 'Work order title. Defaults to "Desconexión de abonado {id}".' },
            },
            required: ['idempotency_key'],
        },
        handler: disconnectSubscriber,
    },
    {
        name: 'find_work_orders',
        title: 'Buscar órdenes de trabajo',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description:
            'List work orders filtered by client_id (or a subscriber query that matches exactly one subscriber, otherwise '
            + 'the candidates are returned and nothing is listed) plus optional type and status.',
        inputSchema: {
            type: 'object',
            properties: {
                client_id: { type: 'integer', description: 'Client id. Mutually exclusive with query.' },
                query: { type: 'string', description: 'Subscriber name or document fragment resolved to a client_id. Mutually exclusive with client_id.' },
                type: { type: 'string', description: 'Work order type filter, e.g. installation.' },
                status: { type: 'string', description: 'Work order status filter, e.g. pending, in_progress, completed, cancelled.' },
            },
        },
        handler: findWorkOrders,
    },
    {
        name: 'find_technician',
        title: 'Buscar técnico',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Find active employees by name fragment. Use employee_id from the single result for assign_installation.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Employee name fragment.' },
            },
            required: ['query'],
        },
        handler: findTechnician,
    },
    {
        name: 'assign_installation',
        title: 'Asignar instalación',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description:
            'Assign a pending installation to a technician. Resolve the order either by work_order_id or by a subscriber '
            + 'query (which must yield exactly one pending installation), and the technician either by employee_id or by a '
            + 'name query that must match exactly one active employee. Ambiguous lookups return their candidates and do not assign.',
        inputSchema: {
            type: 'object',
            properties: {
                work_order_id: { type: 'integer', description: 'Work order id. Mutually exclusive with subscriber_query.' },
                subscriber_query: { type: 'string', description: 'Subscriber name or document fragment. Mutually exclusive with work_order_id.' },
                employee_id: { type: 'integer', description: 'Technician employee id. Mutually exclusive with technician_query.' },
                technician_query: { type: 'string', description: 'Technician name fragment. Mutually exclusive with employee_id.' },
            },
        },
        handler: assignInstallation,
    },
    {
        name: 'network_snapshot',
        title: 'Estado de red',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description:
            'Latest online PPP session count and WAN throughput in Mbps for the credential platform, plus their collection '
            + 'timestamps. This is not a 24-hour consumption report and not a saturation percentage; usage_24h.available is '
            + 'always false because RADIUS accounting is not exposed.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: networkSnapshot,
    },
];

/**
 * Return the MCP tool catalogue without the internal handlers, hiding the write
 * tools while the write guardrail is on.
 *
 * @param {Record<string, string|undefined>} [env] Environment bag (defaults to `process.env`).
 * @return {Array<object>}
 */
function listTools(env = process.env) {
    const enabled = writesEnabled(env);

    return TOOLS
        .filter((tool) => enabled || !WRITE_TOOLS.includes(tool.name))
        .map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
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
 * @return {Promise<object>} Tool result payload.
 */
export async function dispatch(name, args, fetchImpl = globalThis.fetch, env = process.env) {
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
        return await tool.handler(args, fetchImpl);
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
export const REDACTED_KEYS = new Set(['document', 'phone', 'email']);

/**
 * Wrap a tool result as an MCP `tools/call` result.
 *
 * @param {unknown} result Tool result payload.
 * @return {object}
 */
function toolCallResult(result) {
    const text = JSON.stringify(result, (key, value) => (REDACTED_KEYS.has(key) ? undefined : value), 2);
    const isError = isPlainObject(result) && (typeof result.error === 'string' || result.success === false);

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
