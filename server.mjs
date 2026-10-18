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

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { fileStamp, saveArtifact } from './lib/artifacts.mjs';
import { GUIDE } from './lib/guide.mjs';
import { normalizeReport, renderReportHtml, ReportInputError, slugify } from './lib/report-html.mjs';

const SERVER_NAME = 'cloudisp-mcp';
const SERVER_VERSION = '0.6.0';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const API_PREFIX = '/api/v1/public';
const REQUEST_TIMEOUT_MS = 30000;

/** How long (and how often) a dispatched device task is polled before the tool answers `pending`. */
const TASK_TIMEOUT_MS = 40000;
const TASK_INTERVAL_MS = 2000;

/** Budget of the device tasks that outlast a read: reboot, sync, reprovision, swap, factory reset. */
const LONG_TASK_TIMEOUT_MS = 110000;

/** Longest `get_task` wait, in seconds (the same budget). */
const MAX_TASK_WAIT_SECONDS = 110;

/**
 * Headers carried by every API request: who asked (the agent runtime's hidden `_operator` argument)
 * and which tool. The API logs them and stamps them on the audit trail of every write.
 */
const OPERATOR_HEADER = 'X-CloudISP-Operator-Id';
const REQUESTED_BY_HEADER = 'X-CloudISP-Requested-By';
const CHANNEL_HEADER = 'X-CloudISP-Channel';
const CONVERSATION_HEADER = 'X-CloudISP-Conversation';
const TOOL_HEADER = 'X-CloudISP-Tool';
const REQUESTED_BY_MAX_LENGTH = 120;
const CONVERSATION_MAX_LENGTH = 128;

/** Channels the API accepts in `X-CloudISP-Channel`. */
const OPERATOR_CHANNELS = ['telegram', 'cli', 'api'];

/** Description prefix of every write tool. */
const WRITE_PREFIX = 'ESCRITURA (requiere confirmación del operador): ';

/** Hint handed to the client during `initialize`: the agent's core rules, condensed. */
const INSTRUCTIONS = [
    'Llamá cloudisp_context al iniciar cada conversación y antes de delegar; obedecé sus reglas y artículos.',
    'Nunca adivines ids: resolvé al abonado con búsqueda y, si hay más de uno, preguntá mostrando candidatos. Dato faltante = "no disponible", nunca 0. Las horas ya vienen en hora de Salta (-03:00): no las conviertas.',
    'Toda escritura: resumen (abonado, id, plataforma, ONU, acción, impacto) y confirmación explícita del operador antes de llamar la tool; una acción por confirmación, nunca encadenes escrituras.',
    'Cada acción queda registrada a nombre de quien la pidió: no pidas ni inventes nombres. Pasá una idempotency_key nueva por acción (reusala solo para reintentar la misma).',
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
 * @param {{ query?: object, body?: object, idempotencyKey?: string, binary?: boolean }} [options] Optional query string, JSON body, idempotency header and, with `binary`, a file answer (`bytes` and `contentType` instead of a JSON body).
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

    const headers = { Authorization: `Bearer ${config.key}`, Accept: options.binary ? 'application/pdf, text/csv, application/json' : 'application/json' };
    const init = { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };

    if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(options.body);
    }

    if (options.idempotencyKey) {
        headers['Idempotency-Key'] = options.idempotencyKey;
    }

    const response = await fetchImpl(url.toString(), init);
    const status = Number.isInteger(response.status) ? response.status : 200;
    const ok = typeof response.ok === 'boolean' ? response.ok : status >= 200 && status < 300;

    if (options.binary && ok) {
        const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();

        if (!contentType.includes('json')) {
            return { ok, status, body: null, bytes: Buffer.from(await response.arrayBuffer()), contentType };
        }
    }

    let body = null;
    try {
        body = await response.json();
    } catch {
        body = null;
    }

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
 * @param {unknown} value Free text.
 * @return {string} ASCII-only header text: accents folded, anything else collapsed to a space.
 */
function asciiHeader(value) {
    return asTrimmedString(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]+/g, ' ').trim();
}

/**
 * Read the hidden `_operator` argument the agent runtime adds to every call: who asked.
 *
 * @param {unknown} raw `{ id, name, channel, conversation, profile }`.
 * @return {{ ref: string, name: string, channel: string, conversation: string }|null} The operator, or null when the
 *     identity is missing or malformed (`<channel>:<id>` must match what the API accepts).
 */
function readOperator(raw) {
    if (!isPlainObject(raw)) {
        return null;
    }

    const channel = asTrimmedString(raw.channel).toLowerCase();
    const id = typeof raw.id === 'number' ? String(raw.id) : asTrimmedString(raw.id);

    if (!/^[a-z]{2,16}$/.test(channel) || !/^[A-Za-z0-9._-]{1,40}$/.test(id)) {
        return null;
    }

    return {
        ref: `${channel}:${id}`,
        name: asciiHeader(raw.name).slice(0, REQUESTED_BY_MAX_LENGTH).trim(),
        channel,
        conversation: asciiHeader(raw.conversation).slice(0, CONVERSATION_MAX_LENGTH).trim(),
    };
}

/**
 * @param {string} tool Tool name.
 * @param {{ ref: string, name: string, channel: string, conversation: string }|null} operator Who asked, if known.
 * @return {Record<string, string>} Identity headers of the tool call.
 */
function identityHeaders(tool, operator) {
    const headers = { [TOOL_HEADER]: tool };

    if (operator !== null) {
        headers[OPERATOR_HEADER] = operator.ref;
        headers[REQUESTED_BY_HEADER] = operator.name || operator.ref;

        if (OPERATOR_CHANNELS.includes(operator.channel)) {
            headers[CHANNEL_HEADER] = operator.channel;
        }

        if (operator.conversation !== '') {
            headers[CONVERSATION_HEADER] = operator.conversation;
        }
    }

    return headers;
}

/**
 * Wrap `fetch` so every request of a tool call, lookups and polling included, carries the identity headers.
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {Record<string, string>} extra Headers to add.
 * @return {Function} `fetch`-compatible implementation.
 */
function withHeaders(fetchImpl, extra) {
    return (url, init) => fetchImpl(url, { ...init, headers: { ...init?.headers, ...extra } });
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
 * Read an optional boolean-like argument: `true`, `false`, `1` or `0` (what the API takes as a flag).
 *
 * @param {object} args Tool arguments.
 * @param {string} key Argument name.
 * @return {boolean|undefined} The flag, or undefined when absent.
 */
function optFlag(args, key) {
    if (!isPresent(args[key])) {
        return undefined;
    }

    const text = String(args[key]).toLowerCase();

    if (!['true', '1', 'false', '0'].includes(text)) {
        fail(invalid(`${key} must be true, false, 1 or 0.`));
    }

    return text === 'true' || text === '1';
}

/**
 * Read an optional digits-only argument (a document, an external id) as the string the API matches exactly.
 *
 * @param {object} args Tool arguments.
 * @param {string} key Argument name.
 * @param {number} maxLength Most digits accepted.
 * @return {string|undefined} The digits, or undefined when absent.
 */
function optDigits(args, key, maxLength) {
    if (!isPresent(args[key])) {
        return undefined;
    }

    const value = typeof args[key] === 'number' && Number.isSafeInteger(args[key]) && args[key] >= 0 ? String(args[key]) : args[key];

    if (typeof value !== 'string' || !new RegExp(`^[0-9]{1,${maxLength}}$`).test(value.trim())) {
        fail(invalid(`${key} must be digits only (no dots, dashes or spaces), at most ${maxLength}.`));
    }

    return value.trim();
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
    const response = await searchSubscribers(fetchImpl, query);

    if (!response.ok) {
        fail(apiFailurePayload(response));
    }

    const rows = Array.isArray(response.body?.data) ? response.body.data : [];

    if (response.body?.meta?.total !== 1 || rows.length !== 1) {
        fail({ error: 'ambiguous_subscriber', candidates: rows });
    }

    return rows[0];
}

/** `#1234` is a subscriber number (id). Bare digits are always a document/name text search. */
const SUBSCRIBER_NUMBER_PATTERN = /^#\s*(\d{1,12})$/;

/**
 * Search subscribers: `#1234` looks up that subscriber number only (missing = no match, never a
 * document fallback); anything else is the API's name/document text search.
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {string} query Name, document fragment or `#` subscriber number.
 * @return {Promise<{ ok: boolean, status: number, body: unknown }>} List-shaped response.
 */
async function searchSubscribers(fetchImpl, query) {
    const match = SUBSCRIBER_NUMBER_PATTERN.exec(query.trim());

    if (match === null) {
        return apiRequest(fetchImpl, 'GET', '/subscribers', { query: { q: query.trim() } });
    }

    const byId = await apiRequest(fetchImpl, 'GET', `/subscribers/${Number(match[1])}`);
    if (byId.ok && byId.body?.data) {
        return { ok: true, status: 200, body: { success: true, data: [byId.body.data], meta: { total: 1, page: 1, per_page: 1, pages: 1 } } };
    }
    if (byId.status === 404) {
        return { ok: true, status: 200, body: { success: true, data: [], meta: { total: 0, page: 1, per_page: 0, pages: 0 } } };
    }

    return byId;
}

/**
 * Require exactly one employee lookup match.
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {string} query Name fragment.
 * @return {Promise<object>} The single serialized employee row.
 */
async function findSingleEmployee(fetchImpl, query) {
    const response = await apiRequest(fetchImpl, 'GET', '/employees', { query: { q: query, assignable: 1 } });

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
 * `find_subscriber` — `GET /subscribers?q=`, with the optional exact filters `status`, `document` and `external_client_id`;
 * `#1234` looks that subscriber number up on its own.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function findSubscriber(args, fetchImpl) {
    const query = asTrimmedString(args.query);
    const filters = {
        status: optFlag(args, 'status'),
        document: optDigits(args, 'document', 32),
        external_client_id: optDigits(args, 'external_client_id', 19),
    };
    const filtered = Object.values(filters).some((value) => value !== undefined);

    if (query === '' && !filtered) {
        fail(invalid('Provide query, document, external_client_id or status.'));
    }

    if (filtered && SUBSCRIBER_NUMBER_PATTERN.test(query)) {
        fail(invalid('A subscriber number (#1234) is an exact lookup: do not combine it with status, document or external_client_id.'));
    }

    const response = filtered
        ? await apiRequest(fetchImpl, 'GET', '/subscribers', { query: { q: query, ...filters } })
        : await searchSubscribers(fetchImpl, query);

    return isFailure(response) ? apiFailurePayload(response) : response.body;
}

/** Statuses `list_internet_profiles` can ask for (`Profiles::LIFECYCLE_STATUSES`); the API lists `active` unless told otherwise. */
const PROFILE_STATUSES = ['active', 'deprecated', 'soft_deleted'];

/**
 * `list_internet_profiles` — `GET /internet-profiles?status=&per_page=100` (the API maximum; the default page is 20); `status` defaults to `active`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function listInternetProfiles(args, fetchImpl) {
    const status = optEnum(args, 'status', PROFILE_STATUSES) ?? 'active';
    const response = await apiRequest(fetchImpl, 'GET', '/internet-profiles', { query: { status, per_page: 100 } });

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

/** Longest `external_ref` the public API accepts on a work order. */
const WORK_ORDER_REF_MAX_LENGTH = 100;

/**
 * The work order `external_ref` that stands for an idempotency key: the key itself when it fits, otherwise a digest of it.
 * The same key always gives the same ref, so a replay stays idempotent, and the ref never passes the API cap.
 *
 * @param {string} key Idempotency key (up to 128 characters).
 * @return {string} A ref of at most {@link WORK_ORDER_REF_MAX_LENGTH} characters.
 */
function workOrderRef(key) {
    return key.length <= WORK_ORDER_REF_MAX_LENGTH ? key : `idem-${createHash('sha256').update(key).digest('hex')}`;
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
        body: { client_id: subscriberId, type, title, external_ref: workOrderRef(idempotencyKey) },
    });

    if (isFailure(workOrder)) {
        return { ...result, work_order_error: apiFailurePayload(workOrder) };
    }

    return { ...result, work_order: workOrder.body };
}

/** Work-order statuses `GET /work-orders` filters by (the model's own vocabulary). */
const WORK_ORDER_STATUSES = ['pending', 'in_progress', 'incomplete', 'completed', 'cancelled'];

/** Target statuses `POST /work-orders/{id}/status` accepts; the manager-only reopen is not exposed. */
const WORK_ORDER_STATUS_TARGETS = ['in_progress', 'completed', 'cancelled'];

/** Work-order priorities `GET /work-orders` filters by. */
const WORK_ORDER_PRIORITIES = ['low', 'medium', 'high'];

/** Longest cancellation reason the status route accepts. */
const WORK_ORDER_REASON_MAX_LENGTH = 500;

/**
 * `find_work_orders` — optional subscriber (`subscriber_id` or `subscriber_query`), optional
 * `type`/`status`/`priority`/`assigned_to`/`scheduled_from`/`scheduled_to`/`overdue`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function findWorkOrders(args, fetchImpl) {
    const clientId = await resolveSubscriberId(fetchImpl, args, { optional: true });

    return call(fetchImpl, 'GET', '/work-orders', {
        query: {
            client_id: clientId,
            type: asTrimmedString(args.type),
            status: optEnum(args, 'status', WORK_ORDER_STATUSES),
            priority: optEnum(args, 'priority', WORK_ORDER_PRIORITIES),
            assigned_to: optInt(args, 'assigned_to'),
            scheduled_from: asTrimmedString(args.scheduled_from),
            scheduled_to: asTrimmedString(args.scheduled_to),
            overdue: optFlag(args, 'overdue'),
            ...pageQuery(args),
        },
    });
}

/**
 * `find_technician` — `GET /employees?q=&assignable=1`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function findTechnician(args, fetchImpl) {
    const query = requireQuery(args.query);
    const response = await apiRequest(fetchImpl, 'GET', '/employees', { query: { q: query, assignable: 1 } });

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
 * `update_work_order_status` — `POST /work-orders/{id}/status`.
 *
 * The server's transition table decides: only `in_progress`, `completed` (non-installations) and
 * `cancelled` (with a reason) are reachable, and an installation never completes this way.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function updateWorkOrderStatus(args, fetchImpl) {
    const idempotencyKey = requireIdempotencyKey(args);
    const workOrderId = requireId(args, 'work_order_id');
    const status = optEnum(args, 'status', WORK_ORDER_STATUS_TARGETS);

    if (status === undefined) {
        fail(invalid(`status is required and must be one of: ${WORK_ORDER_STATUS_TARGETS.join(', ')}.`));
    }

    const reason = asTrimmedString(args.reason);

    if (status === 'cancelled' && reason === '') {
        fail(invalid('reason is required to cancel a work order: ask the operator why before calling.'));
    }

    if (reason.length > WORK_ORDER_REASON_MAX_LENGTH) {
        fail(invalid(`reason is at most ${WORK_ORDER_REASON_MAX_LENGTH} characters.`));
    }

    return call(fetchImpl, 'POST', `/work-orders/${workOrderId}/status`, {
        body: reason === '' ? { status } : { status, reason },
        idempotencyKey,
    });
}

/**
 * `network_snapshot` — `GET /operations/snapshot`, optionally for one platform.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function networkSnapshot(args, fetchImpl) {
    return call(fetchImpl, 'GET', '/operations/snapshot', { query: { platform_id: optInt(args, 'platform_id') } });
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
 * @param {number} [timeoutMs] Polling budget (the 40 s default when omitted).
 * @return {Promise<object>} Failure payload, the dispatch body when it carries no task, or the awaited projection (with `replayed` when the API reported it).
 */
async function awaitDispatched(fetchImpl, clock, response, timeoutMs) {
    if (isFailure(response)) {
        return apiFailurePayload(response);
    }

    const body = response.body;
    const taskRunId = asPositiveInt(body?.task_run_id ?? body?.data?.task_run_id);

    if (taskRunId === null) {
        return body;
    }

    const task = await awaitTask(fetchImpl, taskRunId, timeoutMs === undefined ? clock : { ...clock, timeoutMs });
    const replayed = body.replayed ?? body.data?.replayed;

    const extra = { ...(replayed === undefined ? {} : { replayed }) };
    const rotated = body.credential_rotated ?? body.data?.credential_rotated;

    if (rotated !== undefined) {
        extra.credential_rotated = rotated;
    }

    return { ...task, ...extra };
}

// ─── Read handlers ───────────────────────────────────────────────────────────

/** ONU read operations `POST /subscribers/{id}/onu/reads` accepts. */
const ONU_READ_OPERATIONS = [
    'olt.onu_details_read', 'olt.onu_health_check', 'onu.tr069_read', 'onu.wan_read',
    'onu.wifi_read', 'onu.catv_read', 'onu.wifi_diagnose', 'onu.wifi_password_check',
];

/** OLT read operations the public API may enable (netwatcher routable ∩ admin allowlist). */
const OLT_READ_OPERATIONS = [
    'olt.health_check', 'olt.system_info_read', 'olt.mac_table_read', 'olt.poll',
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
 * `onu_read` — `POST /subscribers/{id}/onu/reads`, then waits for the task. `onu.wifi_password_check` is based on a
 * fresh `onu.wifi_read`, like the WiFi writes.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @return {Promise<object>} Final task projection, or the failure payload.
 */
async function onuRead(args, fetchImpl, clock) {
    const operation = requireOperation(args, ONU_READ_OPERATIONS);
    let ssidIndex = null;

    if (operation === 'onu.wifi_password_check') {
        ssidIndex = asPositiveInt(isPlainObject(args.parameters) ? args.parameters.ssid_index : undefined);

        if (ssidIndex === null || ssidIndex > 8) {
            fail(invalid('onu.wifi_password_check requires parameters.ssid_index (1 to 8).'));
        }
    }

    const subscriberId = await resolveSubscriberId(fetchImpl, args);
    const path = `/subscribers/${subscriberId}/onu/reads`;

    if (ssidIndex === null) {
        return postRead(fetchImpl, clock, path, operation, args);
    }

    const read = await requireWifiRead(fetchImpl, clock, subscriberId);

    return postRead(fetchImpl, clock, path, operation, { parameters: { ssid_index: ssidIndex, based_on_task_run_id: read.task_run_id } });
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
 * `get_task` — `GET /tasks/{id}`; with `wait_seconds` it polls until the task is final or the time is up.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @return {Promise<object>} Task projection, `{ status: 'pending', task_run_id }` when it did not finish in time, or the failure payload.
 */
async function getTask(args, fetchImpl, clock) {
    const taskRunId = requireId(args, 'task_run_id');
    const waitSeconds = optInt(args, 'wait_seconds', 0) ?? 0;

    if (waitSeconds > MAX_TASK_WAIT_SECONDS) {
        fail(invalid(`wait_seconds must be between 0 and ${MAX_TASK_WAIT_SECONDS}.`));
    }

    if (waitSeconds === 0) {
        return call(fetchImpl, 'GET', `/tasks/${taskRunId}`);
    }

    return awaitTask(fetchImpl, taskRunId, { ...clock, timeoutMs: waitSeconds * 1000 });
}

/** ONU states `GET /network/onus` filters by (`absent` is a presentation state for ONUs the OLT no longer registers). */
const ONU_STATES = ['online', 'offline', 'unknown', 'absent'];

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
            state: optEnum(args, 'state', ONU_STATES),
            client_id: clientId,
            olt_id: optInt(args, 'olt_id'),
            pon_slot: optInt(args, 'pon_slot', 0),
            pon_port: optInt(args, 'pon_port', 0),
            platform_id: optInt(args, 'platform_id'),
            product_class: asTrimmedString(args.product_class),
            firmware: asTrimmedString(args.firmware),
            serial: asTrimmedString(args.serial),
            serial_prefix: asTrimmedString(args.serial_prefix),
            mac: asTrimmedString(args.mac),
            mac_prefix: asTrimmedString(args.mac_prefix),
            offline_only: args.offline_only === true ? 1 : undefined,
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

/** Alert statuses `GET /network/alerts` filters by (`active` is open or acknowledged, the API default; `all` lifts the filter). */
const ALERT_STATUSES = ['open', 'acknowledged', 'closed', 'active', 'all'];

/** Alert severities `GET /network/alerts` filters by. */
const ALERT_SEVERITIES = ['critical', 'warning', 'info'];

/**
 * `network_alerts` — `GET /network/alerts`, filtered and paged.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function networkAlerts(args, fetchImpl) {
    return call(fetchImpl, 'GET', '/network/alerts', {
        query: {
            status: optEnum(args, 'status', ALERT_STATUSES),
            severity: optEnum(args, 'severity', ALERT_SEVERITIES),
            type: asTrimmedString(args.type),
            olt_id: optInt(args, 'olt_id'),
            device_id: optInt(args, 'device_id'),
            since: asTrimmedString(args.since),
            until: asTrimmedString(args.until),
            limit: optInt(args, 'limit'),
            page: optInt(args, 'page'),
        },
    });
}

/**
 * `get_alert` — `GET /network/alerts/{id}`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function getAlert(args, fetchImpl) {
    return call(fetchImpl, 'GET', `/network/alerts/${requireId(args, 'alert_id')}`);
}

/** Windows the series endpoint accepts (the API default is `24h`). */
const METRIC_WINDOWS = ['15m', '1h', '6h', '24h', '7d', '30d'];

/** Series resolutions the API accepts (the API default is `auto`). */
const METRIC_RESOLUTIONS = ['auto', 'raw', 'trend_1h'];

/** Most metric ids one series call takes. */
const METRIC_IDS_MAX = 8;

/** Metric, family and template ids are opaque: 64 lowercase hex characters, only ever copied from the catalogue. */
const METRIC_ID_PATTERN = /^[0-9a-f]{64}$/;

/** Most rows one catalogue page returns. */
const CATALOG_LIMIT_MAX = 500;

/**
 * Read an optional catalogue id argument (`family_id`, `template_id`).
 *
 * @param {object} args Tool arguments.
 * @param {string} key Argument name.
 * @return {string|undefined} The id, or undefined when absent.
 */
function optCatalogId(args, key) {
    if (!isPresent(args[key])) {
        return undefined;
    }

    if (typeof args[key] !== 'string' || !METRIC_ID_PATTERN.test(args[key])) {
        fail(invalid(`${key} must be an id taken from the catalogue: 64 lowercase hex characters.`));
    }

    return args[key];
}

/**
 * `device_metrics` — the metric catalogue of a device (filtered and paged with `search`, `family_id`, `template_id`,
 * `state`, `selected`, `cursor` and `limit`), or the series of the requested `metric_ids`. Bounds are checked before any request.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function deviceMetrics(args, fetchImpl) {
    const kind = requireDeviceKind(args);

    const base = `/network/devices/${kind}/${requireId(args, 'device_id')}/metrics`;

    if (isPresent(args.metric_ids) && !Array.isArray(args.metric_ids)) {
        fail(invalid('metric_ids must be an array of metric ids.'));
    }

    const metricIds = args.metric_ids ?? [];

    if (metricIds.length === 0) {
        const selected = optFlag(args, 'selected');

        return call(fetchImpl, 'GET', `${base}/catalog`, {
            query: {
                search: asTrimmedString(args.search),
                family_id: optCatalogId(args, 'family_id'),
                template_id: optCatalogId(args, 'template_id'),
                state: asTrimmedString(args.state),
                selected: selected === undefined ? undefined : Number(selected),
                cursor: asTrimmedString(args.cursor),
                limit: optLimit(args, CATALOG_LIMIT_MAX),
            },
        });
    }

    if (metricIds.length > METRIC_IDS_MAX || !metricIds.every((id) => typeof id === 'string' && METRIC_ID_PATTERN.test(id))) {
        fail(invalid(
            `metric_ids takes 1 to ${METRIC_IDS_MAX} ids of 64 lowercase hex characters, copied from the catalogue `
            + '(call device_metrics without metric_ids first); names such as cpu or mem are not ids.',
        ));
    }

    return call(fetchImpl, 'GET', `${base}/series`, {
        query: {
            metric_id: metricIds,
            window: optEnum(args, 'window', METRIC_WINDOWS),
            resolution: optEnum(args, 'resolution', METRIC_RESOLUTIONS),
        },
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

/** Formats `export_report` can ask the API for, with the content type each must come back as. */
const REPORT_FORMATS = { pdf: 'application/pdf', csv: 'text/csv' };

/**
 * `export_report` — `GET /reports/{key}?format=pdf|csv` (`from`/`to` travel as `filter_period=<from>,<to>`, other `filters` as given): save the file and hand back its `MEDIA:` line.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} _clock Clock seams (unused).
 * @param {Record<string, string|undefined>} env Environment bag (artifact directory).
 * @return {Promise<object>} `{ ok, path, media, bytes }`, or a failure payload.
 */
async function exportReport(args, fetchImpl, _clock, env) {
    const key = asTrimmedString(args.key);
    const format = asTrimmedString(args.format).toLowerCase();

    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) {
        fail(invalid('key is required: a report key from list_reports.'));
    }

    if (!Object.hasOwn(REPORT_FORMATS, format)) {
        fail(invalid('format is required: pdf or csv.'));
    }

    const dates = {};

    for (const name of ['from', 'to']) {
        if (isPresent(args[name])) {
            if (typeof args[name] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args[name].trim())) {
                fail(invalid(`${name} must be a date as YYYY-MM-DD.`));
            }

            dates[name] = args[name].trim();
        }
    }

    if (Object.keys(dates).length === 1) {
        fail(invalid('from and to go together: give both dates (YYYY-MM-DD) or neither.'));
    }

    const query = { ...(isPlainObject(args.filters) ? args.filters : {}), format, platform_id: optInt(args, 'platform_id') };

    if (dates.from !== undefined) {
        query.filter_period = `${dates.from},${dates.to}`;
    }

    const response = await apiRequest(fetchImpl, 'GET', `/reports/${key}`, { query, binary: true });

    if (isFailure(response)) {
        fail(apiFailurePayload(response));
    }

    if (!Buffer.isBuffer(response.bytes) || !response.contentType.includes(REPORT_FORMATS[format])) {
        fail({ error: 'unexpected_response', message: `The API did not answer a ${format} file for report ${key}.` });
    }

    const { path, bytes } = saveArtifact(env, `reporte-${key}-${fileStamp()}.${format}`, response.bytes);

    return { ok: true, path, media: `MEDIA:${path}`, bytes };
}

/**
 * `build_report` — render a self-contained HTML report (KPIs, tables, SVG charts) from the agent's own data; no API call.
 *
 * @param {object} args Tool arguments.
 * @param {Function} _fetchImpl `fetch`-compatible implementation (unused).
 * @param {object} _clock Clock seams (unused).
 * @param {Record<string, string|undefined>} env Environment bag (artifact directory).
 * @return {Promise<object>} `{ ok, path, media, bytes }`, or a validation failure.
 */
async function buildReport(args, _fetchImpl, _clock, env) {
    let report;

    try {
        report = normalizeReport(args);
    } catch (error) {
        if (error instanceof ReportInputError) {
            fail(invalid(error.message));
        }

        throw error;
    }

    const { path, bytes } = saveArtifact(env, `informe-${slugify(report.title)}-${fileStamp()}.html`, renderReportHtml(report));

    return { ok: true, path, media: `MEDIA:${path}`, bytes };
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

/** Invoice statuses `GET /invoices` filters by. */
const INVOICE_STATUSES = ['draft', 'issued', 'void'];

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
        query: { subscriber_id: subscriberId, status: optEnum(args, 'status', INVOICE_STATUSES), ...pageQuery(args) },
    });
}

/**
 * `get_invoice` — `GET /invoices/{id}`: the header, `subscriber_name`, `lines[]` and the allocated `payments[]`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function getInvoice(args, fetchImpl) {
    return call(fetchImpl, 'GET', `/invoices/${requireId(args, 'invoice_id')}`);
}

/**
 * `get_account_statement` — `GET /subscribers/{id}/account-statement`: the ledger (newest first, paged) and the debt per currency.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function getAccountStatement(args, fetchImpl) {
    const query = pageQuery(args);
    const subscriberId = await resolveSubscriberId(fetchImpl, args);

    return call(fetchImpl, 'GET', `/subscribers/${subscriberId}/account-statement`, { query });
}

/** Currencies an invoice, and so a debt, can be in (`ck_billing_invoices_currency`). */
const DEBT_CURRENCIES = ['ARS', 'USD'];

/**
 * `list_debtors` — `GET /collections/debtors`: one row per subscriber and currency, never a sum across currencies.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function listDebtors(args, fetchImpl) {
    const name = asTrimmedString(args.query);

    // The API ignores a one-character search; refuse it so the agent does not believe the list was filtered.
    if (name !== '' && name.length < 2) {
        fail(invalid('query must be at least 2 characters.'));
    }

    return call(fetchImpl, 'GET', '/collections/debtors', {
        query: { currency: optEnum(args, 'currency', DEBT_CURRENCIES), q: name, ...pageQuery(args) },
    });
}

/** Cutoff states `GET /collections/cutoffs` filters by. */
const CUTOFF_STATUSES = ['cut_off', 'active'];

/**
 * `list_cutoffs` — `GET /collections/cutoffs`, or `GET /subscribers/{id}/cutoffs` for one subscriber, with optional history.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function listCutoffs(args, fetchImpl) {
    const history = optFlag(args, 'history');
    const query = { status: optEnum(args, 'status', CUTOFF_STATUSES), history: history === true ? 1 : undefined, ...pageQuery(args) };
    const subscriberId = await resolveSubscriberId(fetchImpl, args, { optional: true });

    return call(fetchImpl, 'GET', subscriberId === null ? '/collections/cutoffs' : `/subscribers/${subscriberId}/cutoffs`, { query });
}

/** Windows `subscriber_usage` accepts. */
const USAGE_WINDOWS = ['24h', '7d', '30d'];

/** Windows `usage_ranking` accepts. */
const RANKING_WINDOWS = ['24h', '7d'];

/** `live_traffic` re-asks while the router watch starts: this many POSTs, this far apart. */
const LIVE_TRAFFIC_ATTEMPTS = 5;
const LIVE_TRAFFIC_INTERVAL_MS = 2000;

/**
 * Read an optional enum argument.
 *
 * @param {object} args Tool arguments.
 * @param {string} key Argument name.
 * @param {string[]} allowed Accepted values.
 * @return {string|undefined} The value, or undefined when absent.
 */
function optEnum(args, key, allowed) {
    if (!isPresent(args[key])) {
        return undefined;
    }

    if (!allowed.includes(args[key])) {
        fail(invalid(`${key} must be one of: ${allowed.join(', ')}.`));
    }

    return args[key];
}

/**
 * Read an optional `limit` argument capped at `max`.
 *
 * @param {object} args Tool arguments.
 * @param {number} max Largest accepted value.
 * @return {number|undefined} The limit, or undefined when absent.
 */
function optLimit(args, max) {
    const limit = optInt(args, 'limit');

    if (limit !== undefined && limit > max) {
        fail(invalid(`limit must be at most ${max}.`));
    }

    return limit;
}

/**
 * @param {object} args Tool arguments.
 * @return {string} The `kind` argument, one of {@link DEVICE_KINDS}.
 */
function requireDeviceKind(args) {
    const kind = asTrimmedString(args.kind);

    if (!DEVICE_KINDS.includes(kind)) {
        fail(invalid(`kind must be one of: ${DEVICE_KINDS.join(', ')}.`));
    }

    return kind;
}

/**
 * `list_onu_models` — `GET /network/onu-models`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function listOnuModels(args, fetchImpl) {
    return call(fetchImpl, 'GET', '/network/onu-models', { query: { platform_id: optInt(args, 'platform_id') } });
}

/**
 * `subscriber_usage` — `GET /subscribers/{id}/usage`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function subscriberUsage(args, fetchImpl) {
    const span = optEnum(args, 'window', USAGE_WINDOWS);
    const subscriberId = await resolveSubscriberId(fetchImpl, args);

    return call(fetchImpl, 'GET', `/subscribers/${subscriberId}/usage`, { query: { window: span } });
}

/**
 * `usage_ranking` — `GET /network/usage/ranking`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function usageRanking(args, fetchImpl) {
    return call(fetchImpl, 'GET', '/network/usage/ranking', {
        query: {
            platform_id: optInt(args, 'platform_id'),
            olt_id: optInt(args, 'olt_id'),
            pon_slot: optInt(args, 'pon_slot', 0),
            pon_port: optInt(args, 'pon_port', 0),
            window: optEnum(args, 'window', RANKING_WINDOWS),
            order: optEnum(args, 'order', ['asc', 'desc']),
            limit: optLimit(args, 50),
        },
    });
}

/**
 * `device_tasks` — the last device tasks of a router/OLT (`kind` + `device_id`) or of a subscriber.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function deviceTasks(args, fetchImpl) {
    const hasDevice = isPresent(args.kind) || isPresent(args.device_id);
    const hasSubscriber = isPresent(args.subscriber_id) || asTrimmedString(args.subscriber_query) !== '';

    if (hasDevice === hasSubscriber) {
        fail(invalid('Provide either kind + device_id, or a subscriber (subscriber_id or subscriber_query).'));
    }

    const limit = optLimit(args, 50);

    if (hasSubscriber) {
        return call(fetchImpl, 'GET', `/subscribers/${await resolveSubscriberId(fetchImpl, args)}/tasks`, { query: { limit } });
    }

    const kind = requireDeviceKind(args);

    return call(fetchImpl, 'GET', `/network/devices/${kind}/${requireId(args, 'device_id')}/tasks`, { query: { limit } });
}

/**
 * `get_router` — `GET /network/routers/{id}`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function getRouter(args, fetchImpl) {
    return call(fetchImpl, 'GET', `/network/routers/${requireId(args, 'router_id')}`);
}

/**
 * `olt_poll_runs` — `GET /network/olts/{id}/poll-runs`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function oltPollRuns(args, fetchImpl) {
    return call(fetchImpl, 'GET', `/network/olts/${requireId(args, 'olt_id')}/poll-runs`, { query: { limit: optInt(args, 'limit') } });
}

/**
 * `list_eoc_masters` — `GET /network/eoc-masters`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @return {Promise<object>} Public API envelope.
 */
async function listEocMasters(args, fetchImpl) {
    return call(fetchImpl, 'GET', '/network/eoc-masters', { query: { platform_id: optInt(args, 'platform_id') } });
}

/**
 * `live_traffic` — `POST /subscribers/{id}/live-traffic`. The first call only starts the router watch (202; its task never carries the
 * sample), so it asks again every 2 s, up to 5 times, until the API answers 200 with the sample.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @return {Promise<object>} Public API envelope, or `{ status: 'pending', task_run_id }` when no sample arrived.
 */
async function liveTraffic(args, fetchImpl, clock) {
    const subscriberId = await resolveSubscriberId(fetchImpl, args);
    let taskRunId = null;

    for (let attempt = 1; attempt <= LIVE_TRAFFIC_ATTEMPTS; attempt += 1) {
        const response = await apiRequest(fetchImpl, 'POST', `/subscribers/${subscriberId}/live-traffic`, { body: {} });

        if (isFailure(response)) {
            return apiFailurePayload(response);
        }

        if (response.status !== 202) {
            return response.body;
        }

        taskRunId = asPositiveInt(response.body?.task_run_id ?? response.body?.data?.task_run_id) ?? taskRunId;

        if (attempt < LIVE_TRAFFIC_ATTEMPTS) {
            await clock.sleep(LIVE_TRAFFIC_INTERVAL_MS);
        }
    }

    return { status: 'pending', task_run_id: taskRunId, message: 'The live watch is still starting and has no sample yet; call live_traffic again in a few seconds.' };
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
 * POST a write and wait for the device task it dispatches (an answer without a task is returned as is).
 *
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @param {string} path Endpoint below `/api/v1/public`.
 * @param {object} body JSON body.
 * @param {string} idempotencyKey Replay token.
 * @param {number} [timeoutMs] Polling budget (the 40 s default when omitted).
 * @return {Promise<object>} Final task projection, or the failure payload.
 */
async function postWrite(fetchImpl, clock, path, body, idempotencyKey, timeoutMs) {
    return awaitDispatched(fetchImpl, clock, await apiRequest(fetchImpl, 'POST', path, { body, idempotencyKey }), timeoutMs);
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
 * @param {number} [timeoutMs] Polling budget (the 40 s default when omitted).
 * @return {Promise<object>} Final task projection, or the failure payload.
 */
async function onuAction(fetchImpl, clock, subscriberId, idempotencyKey, operation, parameters, timeoutMs) {
    return postWrite(fetchImpl, clock, `/subscribers/${subscriberId}/onu/actions`, { operation, parameters }, idempotencyKey, timeoutMs);
}

/**
 * Build the handler of a write `POST /subscribers/{id}<suffix>`: idempotency key and body are validated before any HTTP call,
 * then the subscriber is resolved, the request sent and its task awaited.
 *
 * @param {string} suffix Path suffix below the subscriber.
 * @param {number} [timeoutMs] Polling budget (the 40 s default when omitted).
 * @param {Function} [buildBody] Validates the arguments and returns the JSON body (`{}` by default).
 * @return {Function} Tool handler.
 */
function subscriberWrite(suffix, timeoutMs, buildBody = () => ({})) {
    return async (args, fetchImpl, clock) => {
        const idempotencyKey = requireIdempotencyKey(args);
        const body = buildBody(args);
        const subscriberId = await resolveSubscriberId(fetchImpl, args);

        return postWrite(fetchImpl, clock, `/subscribers/${subscriberId}${suffix}`, body, idempotencyKey, timeoutMs);
    };
}

/**
 * Build the handler of an ONU write sent through `POST /subscribers/{id}/onu/actions`.
 *
 * @param {string} operation Write operation.
 * @param {number} [timeoutMs] Polling budget (the 40 s default when omitted).
 * @param {Function} [buildParameters] Validates the arguments and returns the operation parameters (`{}` by default).
 * @return {Function} Tool handler.
 */
function onuActionHandler(operation, timeoutMs, buildParameters = () => ({})) {
    return subscriberWrite('/onu/actions', timeoutMs, (args) => ({ operation, parameters: buildParameters(args) }));
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

/** `reboot_onu` — `onu.reboot` through `POST /subscribers/{id}/onu/actions`; the ONU takes over a minute to come back. */
const rebootOnu = onuActionHandler('onu.reboot', LONG_TASK_TIMEOUT_MS);

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
 * `rotate_pppoe_password` body: sent only when the operator explicitly asked (`true`); never implicit.
 *
 * @param {object} args Tool arguments.
 * @return {object} `{ rotate_pppoe_password: true }` or `{}`.
 */
function rotateBody(args) {
    return args.rotate_pppoe_password === true ? { rotate_pppoe_password: true } : {};
}

/** `sync_onu` — `POST /subscribers/{id}/onu/sync`, then waits for the task. */
const syncOnu = subscriberWrite('/onu/sync', LONG_TASK_TIMEOUT_MS, rotateBody);

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

/**
 * Parameters of `olt.onu_admin_state`.
 *
 * @param {object} args Tool arguments.
 * @return {{ admin_state: string }}
 */
function adminStateParameters(args) {
    if (!['enable', 'disable'].includes(args.admin_state)) {
        fail(invalid('admin_state must be enable or disable.'));
    }

    return { admin_state: args.admin_state };
}

/**
 * Parameters of `onu.factory_reset`: the operator's explicit confirmation, passed as the literal text.
 *
 * @param {object} args Tool arguments.
 * @return {{ confirm: string }}
 */
function factoryResetParameters(args) {
    if (args.confirm !== 'factory_reset') {
        fail(invalid('confirm must be exactly "factory_reset", and only after the operator explicitly confirmed the factory reset of the ONU.'));
    }

    return { confirm: 'factory_reset' };
}

/**
 * Parameters of `onu.wifi_optimize`: `preview` carries nothing else, `apply` the plan the preview returned.
 *
 * @param {object} args Tool arguments.
 * @return {object}
 */
function wifiOptimizeParameters(args) {
    if (!['preview', 'apply'].includes(args.mode)) {
        fail(invalid('mode must be preview or apply.'));
    }

    if (args.mode === 'preview') {
        if (isPresent(args.plan)) {
            fail(invalid('plan is only allowed with mode apply.'));
        }

        return { mode: 'preview' };
    }

    if (!Array.isArray(args.plan) || args.plan.length === 0 || !args.plan.every(isPlainObject)) {
        fail(invalid('plan is required with mode apply: the result.plan items of the preview, unchanged.'));
    }

    return { mode: 'apply', plan: args.plan };
}

/**
 * Require the MAC of an ONU: 12 hexadecimal characters, separators allowed. Sent as typed; the API normalizes it.
 *
 * @param {object} args Tool arguments.
 * @return {string} The MAC.
 */
function requireMac(args) {
    const mac = asTrimmedString(args.mac);

    if (!/^[0-9a-f]{12}$/i.test(mac.replace(/[\s:.-]/g, ''))) {
        fail(invalid('mac is required: 12 hexadecimal characters (separators allowed).'));
    }

    return mac;
}

/**
 * Body of `POST /subscribers/{id}/onu/swap`.
 *
 * @param {object} args Tool arguments.
 * @return {object}
 */
function swapBody(args) {
    const networkOnuId = requireId(args, 'network_onu_id');
    const serial = asTrimmedString(args.serial);

    if (serial === '') {
        fail(invalid('serial is required: the serial of the match found by locate_new_onu.'));
    }

    const body = { network_onu_id: networkOnuId, serial, mac: requireMac(args) };

    for (const field of ['ssid_24', 'ssid_5']) {
        if (asTrimmedString(args[field]) !== '') {
            body[field] = asTrimmedString(args[field]);
        }
    }

    if (isPresent(args.wifi_password)) {
        body.wifi_password = args.wifi_password;
    }

    if (typeof args.keep_password === 'boolean') {
        body.keep_password = args.keep_password;
    }

    if (args.rotate_pppoe_password === true) {
        body.rotate_pppoe_password = true;
    }

    return body;
}

/**
 * `locate_new_onu` — `POST /subscribers/{id}/onu/swap/locate` dispatches one search task per OLT; waits for all of them
 * and merges their `result.matches`.
 *
 * @param {object} args Tool arguments.
 * @param {Function} fetchImpl `fetch`-compatible implementation.
 * @param {object} clock Clock seams (`now`, `sleep`).
 * @return {Promise<object>} `{ success, matches, olts, errors }`, or the failure payload.
 */
async function locateNewOnu(args, fetchImpl, clock) {
    const idempotencyKey = requireIdempotencyKey(args);
    const mac = requireMac(args);
    const oltId = optInt(args, 'olt_id');
    const subscriberId = await resolveSubscriberId(fetchImpl, args);
    const body = oltId === undefined ? { mac } : { mac, olt_id: oltId };
    const response = await apiRequest(fetchImpl, 'POST', `/subscribers/${subscriberId}/onu/swap/locate`, { body, idempotencyKey });

    if (isFailure(response)) {
        return apiFailurePayload(response);
    }

    const data = response.body?.data ?? response.body;
    const dispatched = Array.isArray(data?.tasks) ? data.tasks : [];
    const finished = await Promise.all(dispatched.map((task) => awaitTask(fetchImpl, task.task_run_id, clock)));
    const matches = [];
    const olts = dispatched.map((task, index) => {
        const done = finished[index];

        for (const match of Array.isArray(done.result?.matches) ? done.result.matches : []) {
            matches.push({ olt_id: task.olt_id, olt_name: task.olt_name, ...match });
        }

        return {
            olt_id: task.olt_id,
            olt_name: task.olt_name,
            task_run_id: task.task_run_id,
            status: done.status ?? null,
            error_code: done.error_code ?? done.error?.code ?? null,
        };
    });

    return {
        success: true,
        matches,
        olts,
        errors: Array.isArray(data?.errors) ? data.errors : [],
        ...(data?.replayed === undefined ? {} : { replayed: data.replayed }),
    };
}

/** `set_onu_admin_state` — `olt.onu_admin_state` through `POST /subscribers/{id}/onu/actions`. */
const setOnuAdminState = onuActionHandler('olt.onu_admin_state', undefined, adminStateParameters);

/** `factory_reset_onu` — `onu.factory_reset`; the ONU is wiped and rebooted. */
const factoryResetOnu = onuActionHandler('onu.factory_reset', LONG_TASK_TIMEOUT_MS, factoryResetParameters);

/** `optimize_wifi` — `onu.wifi_optimize`; `preview` is a pure read of the plan. */
const optimizeWifi = onuActionHandler('onu.wifi_optimize', undefined, wifiOptimizeParameters);

/** `restore_wifi` — `onu.wifi_restore`. */
const restoreWifi = onuActionHandler('onu.wifi_restore');

/** `reprovision_onu` — `POST /subscribers/{id}/onu/provision` (mode reprovision). */
const reprovisionOnu = subscriberWrite('/onu/provision', LONG_TASK_TIMEOUT_MS);

/** `kick_pppoe` — `POST /subscribers/{id}/pppoe/kick`; answers synchronously. */
const kickPppoe = subscriberWrite('/pppoe/kick');

/** `swap_onu` — `POST /subscribers/{id}/onu/swap`. */
const swapOnu = subscriberWrite('/onu/swap', LONG_TASK_TIMEOUT_MS, swapBody);

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

/** Arguments every write tool requires. The operator is not one of them: the agent runtime injects it as the hidden `_operator`. */
const WRITE_PROPERTIES = {
    idempotency_key: {
        type: 'string',
        description: 'Replay token (^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$), reused verbatim as the Idempotency-Key header. A new value per action; reuse it only to retry the same action.',
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
 * Declare a write tool: hidden without `CLOUDISP_ALLOW_WRITES=1`, `idempotency_key` required.
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
            required: ['idempotency_key', ...required],
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
        'Find subscribers by subscriber number written as #1234 (exact id), or by text (query): the name, surname, document, PPPoE user, MAC, phone, address, city, '
        + 'e-mail and legacy external id are all searchable, accents and case fold (a dotted DNI works), and every word of the term must match. Also by the exact filters document '
        + '(digits only), external_client_id (digits only) and status; filters combine with AND, and at least one of query, document, external_client_id or status is required. '
        + 'The response carries the flat profile_name, node_name and olt_name beside their ids. '
        + 'Read the meta.total field: a write tool that needs a single subscriber refuses to act when it is not 1.',
        {
            query: { type: 'string', description: 'Subscriber number as #1234 (alone: not combinable with the filters), or a text fragment: name, surname, document, PPPoE user, MAC, phone, address, city, e-mail or legacy client id.' },
            document: { type: 'string', description: 'Exact document, digits only (no dots, dashes or spaces).' },
            external_client_id: { type: 'string', description: 'Exact external client id, digits only.' },
            status: { type: 'boolean', description: 'The subscriber record\'s boolean status flag (true or false; 1 and 0 also work); not the lifecycle status.' },
        },
        findSubscriber,
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
        'One-call diagnosis of a subscriber (kept small): subscriber (without phone, e-mail or document, with the flat profile_name, node_name and olt_name), '
        + 'service (the active contract: plan name, code, service, download_kbps, upload_kbps, price_cents with currency and since; {found: false} without one), '
        + 'billing (open_cutoff, overdue_invoices, debt_by_currency [{currency, debt_cents, overdue_cents}] -- one row per currency, ARS and USD are never added together --, oldest_due_date and '
        + 'last_payment {amount_cents, currency, method, origin, received_at}, null while the subscriber never paid), problems (the open or acknowledged alerts that name the subscriber, its ONU, its PON port or its OLT, like the admin '
        + '\'active problems\' card), onu (state and last optical reading with the last 12 samples and their min/avg/max), network_context (PPPoE session, last 24 h; PON and uplink traffic come as summarised series '
        + '{state, series: [{name, unit, last, min, avg, max, last_at, points}]}), consumption (at most 5 recent entries; use subscriber_usage for bytes), activity and open work orders. '
        + 'A section that cannot be built is null and listed in section_errors; null means "no disponible", never 0.',
        SUBSCRIBER_PROPERTIES,
        diagnoseSubscriber,
    ),
    readTool(
        'onu_read',
        'Leer ONU',
        'Read the subscriber\'s ONU through a device task and wait up to 40 s for the result. It does not change the equipment. Returns the '
        + 'final task projection ({success, status, task_run_id, error_code, message, result}); when the task is still running it returns '
        + '{status: "pending", task_run_id}: follow it with get_task (wait_seconds). Operations: olt.onu_details_read, olt.onu_health_check, onu.tr069_read '
        + '(parameters {refresh: boolean}), onu.wan_read, onu.wifi_read, onu.catv_read, onu.wifi_diagnose, onu.wifi_password_check (parameters {ssid_index}; '
        + 'reads the ONU WiFi first and answers result.match true, false or "unreadable"; password_unknown when CloudISP has no password on record for that network).',
        {
            ...SUBSCRIBER_PROPERTIES,
            operation: { type: 'string', enum: ONU_READ_OPERATIONS, description: 'ONU read operation.' },
            parameters: { type: 'object', description: 'Operation parameters: onu.tr069_read takes {refresh: boolean}; onu.wifi_password_check requires {ssid_index} (1 to 8).' },
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
        'Current status of a device task (task_run_id from onu_read, olt_read, router_read or an ONU write): status pending, running, succeeded, failed or canceled, plus the safe result. '
        + 'With wait_seconds it polls until the task finishes (or the time is up, then {status: "pending"}): use it after a pending answer instead of asking the user to check later. '
        + 'A succeeded task whose result carries an error comes back as outcome device_error.',
        {
            task_run_id: { type: 'integer', description: 'Task run id.' },
            wait_seconds: { type: 'integer', description: 'Seconds to wait for the task to finish, 0 to 110 (default 0: answer now).' },
        },
        getTask,
        ['task_run_id'],
    ),
    readTool(
        'list_onus',
        'Listar ONUs',
        'List ONUs of the visible platforms, optionally filtered by state (online, offline, unknown, absent), subscriber, OLT, PON, platform, model (product_class), firmware, '
        + 'serial or MAC (exact or prefix), or only the offline ones: with a serial or MAC from a label or a ticket, the row names the subscriber (client) and the PON. '
        + 'Each row carries olt, pon_slot, pon_port, serial_number, mac_address, state, client_id, last_seen_at, offline_since, acs {product_class, firmware, adapter, sync_template, '
        + 'last_inform_at, wifi_channel_24, wifi_channel_5} (null when the ONU has no ACS data), client {id, name} and optical {rx_dbm, band, measured_at, measured_by} '
        + '(the newest receive-power reading, null when there is none in the last 3 days: "no disponible", never 0). band is ok from -25 dBm, warning from -28 to below -25 and critical below -28; '
        + 'there is no TX or temperature. meta.total is the full count: use per_page=1 to only count.',
        {
            state: { type: 'string', enum: ONU_STATES, description: 'ONU state filter (absent: no longer registered on the OLT).' },
            ...SUBSCRIBER_PROPERTIES,
            olt_id: { type: 'integer', description: 'Only ONUs of this OLT.' },
            pon_slot: { type: 'integer', description: 'Only ONUs of this PON slot (combine with olt_id and pon_port).' },
            pon_port: { type: 'integer', description: 'Only ONUs of this PON port (combine with olt_id and pon_slot).' },
            platform_id: { type: 'integer', description: 'Only ONUs of this platform (id from cloudisp_context).' },
            product_class: { type: 'string', description: 'Exact model (ACS product_class), case-insensitive, as listed by list_onu_models.' },
            firmware: { type: 'string', description: 'Exact firmware version, case-insensitive, as listed by list_onu_models.' },
            serial: { type: 'string', description: 'Exact ONU serial number, case-insensitive (e.g. from the label).' },
            serial_prefix: { type: 'string', description: 'ONU serial starting with these 3 to 64 characters (e.g. the vendor prefix HWTC).' },
            mac: { type: 'string', description: 'Exact ONU MAC address, 12 hex digits with or without separators (aa:bb:cc:dd:ee:ff, aabb.ccdd.eeff).' },
            mac_prefix: { type: 'string', description: 'ONU MAC starting with these 4 to 12 hex digits, separators ignored (e.g. the vendor OUI aa:bb:cc).' },
            offline_only: { type: 'boolean', description: 'Only offline ONUs.' },
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
        + 'Operations: olt.health_check, olt.system_info_read, olt.mac_table_read, olt.poll; the API refuses those it has not enabled.',
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
        'List the MikroTik routers of the visible platforms with a health summary: id (the router_id other tools take), name, status, lifecycle_status (active, degraded, disabled), last_health_state and breaker_state. Host credentials are never exposed.',
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
        'Network alerts of the visible platforms, newest first, with meta.total. By default only the active ones (open or acknowledged); status closed or all brings the history. '
        + 'Filter by status (open, acknowledged, closed, active, all), severity (critical, warning, info), type (alert type, e.g. onu_optical_power, olt_unreachable), '
        + 'olt_id, device_id (the router) and since/until (ISO 8601 bounds of the last detection). Each row carries id, severity, status, type, type_label, title, message, '
        + 'device_id (null for an OLT, PON or ONU alert), olt_id, onu_id, client_id, pon_slot, pon_port, version, source, occurrence_count, opened_at, last_detected_at, '
        + 'acknowledged_at, closed_at and closed_reason; use get_alert for the evidence, the transitions and who acknowledged or closed it.',
        {
            status: { type: 'string', enum: ALERT_STATUSES, description: 'Alert state (default active: open or acknowledged; all: every state).' },
            severity: { type: 'string', enum: ALERT_SEVERITIES, description: 'Only alerts of this severity.' },
            type: { type: 'string', description: 'Only alerts of this type, as returned in the rows (e.g. onu_optical_power).' },
            olt_id: { type: 'integer', description: 'Only alerts about this OLT.' },
            device_id: { type: 'integer', description: 'Only alerts about this router (id from list_routers).' },
            since: { type: 'string', description: 'Only alerts last detected at or after this ISO 8601 date or date-time.' },
            until: { type: 'string', description: 'Only alerts last detected at or before this ISO 8601 date or date-time.' },
            limit: { type: 'integer', description: 'Alerts per page (API maximum 100, default 20).' },
            page: { type: 'integer', description: 'Page number, from 1.' },
        },
        networkAlerts,
    ),
    readTool(
        'get_alert',
        'Ver alerta de red',
        'One network alert (id from network_alerts): lifecycle (opened, first and last detected, occurrence_count, version), who acknowledged and resolved it by name, closed_reason, '
        + 'the latest evidence (metric, value, threshold, window), the newest transitions, and what it is about: device (router), olt, onu (serial, PON, state and its latest optical reading), '
        + 'rule, client_id and, when the key may read subscribers, client {id, name}. A missing value is null.',
        { alert_id: { type: 'integer', description: 'Alert id from network_alerts.' } },
        getAlert,
        ['alert_id'],
    ),
    readTool(
        'device_metrics',
        'Métricas de dispositivo',
        'Metrics of a router or OLT. Without metric_ids it returns the metric catalogue of the device (narrow and page it with search, family_id, template_id, state, selected, cursor and limit); '
        + 'with metric_ids it returns their time series. metric_ids are opaque 64-character hex ids that must be taken from the catalogue: call without metric_ids first, never invent names such as cpu or mem.',
        {
            kind: { type: 'string', enum: DEVICE_KINDS, description: 'Device kind.' },
            device_id: { type: 'integer', description: 'Router or OLT id.' },
            metric_ids: {
                type: 'array',
                items: { type: 'string' },
                maxItems: METRIC_IDS_MAX,
                description: 'Opaque metric ids (64 lowercase hex characters) copied from the catalogue, at most 8. Omit to get the catalogue.',
            },
            window: { type: 'string', enum: METRIC_WINDOWS, description: 'Time window of the series. Default 24h.' },
            resolution: { type: 'string', enum: METRIC_RESOLUTIONS, description: 'Series resolution. Default auto.' },
            search: { type: 'string', description: 'Catalogue only: text to search in the metrics.' },
            family_id: { type: 'string', description: 'Catalogue only: family id (64 lowercase hex characters) from a previous catalogue answer.' },
            template_id: { type: 'string', description: 'Catalogue only: template id (64 lowercase hex characters) from a previous catalogue answer.' },
            state: { type: 'string', description: 'Catalogue only: metric state filter.' },
            selected: { type: 'boolean', description: 'Catalogue only: only the selected (true) or not selected (false) metrics.' },
            cursor: { type: 'string', description: 'Catalogue only: cursor of the next page, from the previous answer.' },
            limit: { type: 'integer', description: 'Catalogue only: rows per page, 1 to 500 (default 500).' },
        },
        deviceMetrics,
        ['kind', 'device_id'],
    ),
    readTool(
        'platform_logs',
        'Logs de plataforma',
        'Syslog/event logs of one platform (router and OLT events). The range is at most 7 days and limit at most 500.',
        {
            platform_id: { type: 'integer', description: 'Platform id (from cloudisp_context).' },
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
        'export_report',
        'Exportar reporte',
        'Export one report from list_reports as a PDF or CSV file (GET /reports/{key}?format=). The file is saved locally and the answer is {ok, path, media, bytes}. '
        + 'Para enviarlo, incluí la línea `media` tal cual en tu respuesta.',
        {
            key: { type: 'string', description: 'Report key from list_reports.' },
            format: { type: 'string', enum: ['pdf', 'csv'], description: 'File format.' },
            from: { type: 'string', description: 'Start date, YYYY-MM-DD (reports that declare a date range). Give it together with to.' },
            to: { type: 'string', description: 'End date, YYYY-MM-DD. Give it together with from.' },
            platform_id: { type: 'integer', description: 'Restrict the report to one visible platform.' },
            filters: { type: 'object', description: 'The report\'s declared filters as name/value pairs (filter_<name>), as in run_report.' },
        },
        exportReport,
        ['key', 'format'],
    ),
    readTool(
        'build_report',
        'Armar informe con gráficos',
        'Build a self-contained HTML report in Spanish from data you already read: title, sections with text, KPIs, a table (at most 200 rows) and a bar, line or donut chart. '
        + 'Pass identifiers (subscriber numbers, MAC) as text so they are not formatted as numbers; a null value is drawn as a gap and labelled "no disponible", never as 0. '
        + 'The file is saved locally and the answer is {ok, path, media, bytes}. Para enviarlo, incluí la línea `media` tal cual en tu respuesta.',
        {
            title: { type: 'string', description: 'Report title (at most 200 characters).' },
            subtitle: { type: 'string', description: 'Optional subtitle, e.g. the period or the scope.' },
            sections: {
                type: 'array',
                description: 'Report sections, in order (1 to 20).',
                items: {
                    type: 'object',
                    properties: {
                        heading: { type: 'string', description: 'Section heading.' },
                        text: { type: 'string', description: 'Plain text; a blank line starts a new paragraph.' },
                        kpis: {
                            type: 'array',
                            description: 'Headline figures (at most 12).',
                            items: {
                                type: 'object',
                                properties: {
                                    label: { type: 'string' },
                                    value: { type: ['string', 'number', 'null'], description: 'Figure; null renders as "no disponible".' },
                                },
                                required: ['label', 'value'],
                            },
                        },
                        table: {
                            type: 'object',
                            description: 'A table: columns (at most 12) and rows (at most 200), each row with one cell per column.',
                            properties: {
                                columns: { type: 'array', items: { type: 'string' } },
                                rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } },
                            },
                            required: ['columns', 'rows'],
                        },
                        chart: {
                            type: 'object',
                            description: 'A chart: one value per category in every series (null = missing). A donut takes exactly one series of non-negative values.',
                            properties: {
                                type: { type: 'string', enum: ['bar', 'line', 'donut'] },
                                categories: { type: 'array', items: { type: 'string' } },
                                series: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            name: { type: 'string' },
                                            data: { type: 'array', items: { type: ['number', 'null'] } },
                                        },
                                        required: ['name', 'data'],
                                    },
                                },
                                unit: { type: 'string', description: 'Unit shown next to the values, e.g. GB or %.' },
                            },
                            required: ['type', 'categories', 'series'],
                        },
                    },
                    required: ['heading'],
                },
            },
        },
        buildReport,
        ['title', 'sections'],
    ),
    readTool(
        'list_internet_profiles',
        'Listar perfiles de internet',
        'List the internet profiles of the credential platform (active ones unless status says otherwise) with their id, name, download_max_limit and '
        + 'upload_max_limit. Use profile_id from here for change_subscriber_bandwidth.',
        { status: { type: 'string', enum: PROFILE_STATUSES, description: 'Profile status. Default active.' } },
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
        'List invoices, optionally of one subscriber and status (draft, issued or void). Payment does not change status: remaining debt is balance_cents.',
        {
            ...SUBSCRIBER_PROPERTIES,
            status: { type: 'string', enum: INVOICE_STATUSES, description: 'Invoice status filter.' },
            page: { type: 'integer', description: 'Page number, from 1.' },
            per_page: { type: 'integer', description: 'Rows per page (API maximum 100).' },
        },
        listInvoices,
    ),
    readTool(
        'get_invoice',
        'Ver factura',
        'Fetch one invoice by id (from list_invoices): header, subscriber_name, lines[] and payments[] (amount_cents, currency, method cash|transfer|other, '
        + 'origin mercadopago|transfer|manual, received_at; never a payment memo). Payment does not change status: remaining debt is balance_cents. Amounts are cents of the invoice currency.',
        { invoice_id: { type: 'integer', description: 'Invoice id, from list_invoices.' } },
        getInvoice,
        ['invoice_id'],
    ),
    readTool(
        'get_account_statement',
        'Ver cuenta corriente',
        'Account statement of one subscriber: debt_by_currency (what is owed now, per currency: quote this) and the ledger entries, newest first '
        + '(kind invoice|payment, invoice_id, method, currency, debit_cents, credit_cents). balance_cents is the running balance of that entry\'s currency only: '
        + 'never add amounts of different currencies. Amounts are cents. Paged (page, per_page).',
        {
            ...SUBSCRIBER_PROPERTIES,
            page: { type: 'integer', description: 'Page number, from 1.' },
            per_page: { type: 'integer', description: 'Entries per page (default 20, API maximum 100).' },
        },
        getAccountStatement,
    ),
    readTool(
        'list_debtors',
        'Listar deudores',
        'Subscribers with debt (issued invoices minus payments), one row per subscriber AND currency (currency, debt_cents), by currency and then debt descending: '
        + 'a subscriber that owes in two currencies appears twice. meta.total_debt_by_currency totals every match per currency; never add currencies together. '
        + 'Optional currency (ARS or USD) and name fragment (query, 2+ characters). Amounts are cents.',
        {
            currency: { type: 'string', enum: DEBT_CURRENCIES, description: 'Only the debt in this currency.' },
            query: { type: 'string', description: 'Name fragment of the subscriber (2+ characters).' },
            page: { type: 'integer', description: 'Page number, from 1.' },
            per_page: { type: 'integer', description: 'Rows per page (default 20, API maximum 100).' },
        },
        listDebtors,
    ),
    readTool(
        'list_cutoffs',
        'Listar cortes por cobranza',
        'Collections cutoffs: the current state of every subscriber ever cut off for debt, newest first (status cut_off, or active once reconnected; cutoff_reason, '
        + 'cut_off_at, reconnected_at). debt_cents_at_cutoff comes with its debt_currency; when the currency is ambiguous both are null with debt_currency_reason: '
        + 'then say "no disponible". Pass subscriber_id or subscriber_query for one subscriber; history=true adds each row\'s events (cutoff, reconnect), newest first.',
        {
            ...SUBSCRIBER_PROPERTIES,
            status: { type: 'string', enum: CUTOFF_STATUSES, description: 'cut_off (currently cut) or active (reconnected).' },
            history: { type: 'boolean', description: 'Add the cutoff and reconnect events of each row. Default false.' },
            page: { type: 'integer', description: 'Page number, from 1.' },
            per_page: { type: 'integer', description: 'Rows per page (default 20, API maximum 100).' },
        },
        listCutoffs,
    ),
    readTool(
        'find_work_orders',
        'Buscar órdenes de trabajo',
        'List work orders, optionally of one subscriber (subscriber_id, or a subscriber_query that matches exactly one subscriber, otherwise '
        + 'the candidates are returned and nothing is listed), plus optional type, status, priority, assigned_to (employee id), scheduled_from / '
        + 'scheduled_to (dates YYYY-MM-DD over scheduled_at, inclusive) and overdue (true: appointment in the past and the order not finished). '
        + 'Each row carries created_by {id, name}, the seller the installation contract prints.',
        {
            ...SUBSCRIBER_PROPERTIES,
            type: { type: 'string', description: 'Work order type filter, e.g. installation, technical_visit.' },
            status: { type: 'string', enum: WORK_ORDER_STATUSES, description: 'Work order status filter.' },
            priority: { type: 'string', enum: WORK_ORDER_PRIORITIES, description: 'Work order priority filter.' },
            assigned_to: { type: 'integer', description: 'Only the orders assigned to this employee id (from find_technician).' },
            scheduled_from: { type: 'string', description: 'Appointments on or after this date, YYYY-MM-DD.' },
            scheduled_to: { type: 'string', description: 'Appointments on or before this date, YYYY-MM-DD. Give it together with scheduled_from for a range.' },
            overdue: { type: 'boolean', description: 'true: only the orders whose appointment passed and that are neither completed nor cancelled.' },
            page: { type: 'integer', description: 'Page number, from 1.' },
            per_page: { type: 'integer', description: 'Rows per page (API maximum 100).' },
        },
        findWorkOrders,
    ),
    readTool(
        'get_work_order',
        'Ver orden de trabajo',
        'Fetch one work order by id, with its timeline: the newest 50 history events and the newest 50 comments (newest first; each comment body '
        + 'is cut at 500 characters and flagged truncated). History entries carry the transition (from_status, to_status), who did it and when.',
        { work_order_id: { type: 'integer', description: 'Work order id.' } },
        getWorkOrder,
        ['work_order_id'],
    ),
    readTool(
        'find_technician',
        'Buscar técnico',
        'Find technicians that assign_work_order accepts, by name fragment (each row has role). Use employee_id from the single result for assign_work_order.',
        { query: { type: 'string', description: 'Employee name fragment.' } },
        findTechnician,
        ['query'],
    ),
    readTool(
        'network_snapshot',
        'Estado de red',
        'Latest online PPP session count and WAN throughput in Mbps, plus their collection timestamps. Without platform_id it aggregates every visible platform '
        + 'and lists them in platforms[]; with platform_id (from cloudisp_context) only that one. This is not a 24-hour consumption report and not a saturation '
        + 'percentage (use usage_ranking / subscriber_usage for traffic); usage_24h.available is always false because RADIUS accounting is not exposed here.',
        { platform_id: { type: 'integer', description: 'Only this platform; default all visible platforms.' } },
        networkSnapshot,
    ),
    readTool(
        'list_onu_models',
        'Modelos de ONU',
        'ONU fleet grouped by model and firmware, from the ACS observations: [{product_class, firmware, sync_template, onus, online, offline}]. '
        + 'Use it to answer "how many ONUs of model X / firmware Y"; then list_onus with product_class and firmware gives the subscribers.',
        { platform_id: { type: 'integer', description: 'Only this platform (id from cloudisp_context); default all visible platforms.' } },
        listOnuModels,
    ),
    readTool(
        'subscriber_usage',
        'Consumo del abonado',
        'PPPoE usage of one subscriber over a window (default 24h): download_bytes, upload_bytes, peak_download_bps, peak_upload_bps, last_sample_at and up to 48 '
        + 'buckets {t, down_bytes, up_bytes}. null with a reason when there are no samples; never 0.',
        {
            ...SUBSCRIBER_PROPERTIES,
            window: { type: 'string', enum: USAGE_WINDOWS, description: 'Window: 24h (default), 7d or 30d.' },
        },
        subscriberUsage,
    ),
    readTool(
        'usage_ranking',
        'Ranking de consumo',
        'Ranking of subscribers by PPPoE usage over a window, least traffic first (order asc) or most (desc, default). Rows {client_id, name, platform_id, olt_id, pon_slot, pon_port, '
        + 'download_bytes, upload_bytes}; subscribers without samples are listed apart in no_data and are not "zero traffic".',
        {
            platform_id: { type: 'integer', description: 'Only this platform.' },
            olt_id: { type: 'integer', description: 'Only subscribers behind this OLT.' },
            pon_slot: { type: 'integer', description: 'Only this PON slot (combine with olt_id and pon_port).' },
            pon_port: { type: 'integer', description: 'Only this PON port (combine with olt_id and pon_slot).' },
            window: { type: 'string', enum: RANKING_WINDOWS, description: 'Window: 24h or 7d.' },
            order: { type: 'string', enum: ['asc', 'desc'], description: 'asc = least traffic first.' },
            limit: { type: 'integer', description: 'Rows to return (at most 50).' },
        },
        usageRanking,
    ),
    readTool(
        'device_tasks',
        'Tareas del dispositivo',
        'The last device tasks (at most 50) of a router or OLT (kind + device_id) or of a subscriber (its ONU and router): {id, task_type, device_kind, status, error_type, '
        + 'error_message, created_at, finished_at}. Never the payload or the result: use get_task for those. Provide either kind + device_id or a subscriber.',
        {
            kind: { type: 'string', enum: DEVICE_KINDS, description: 'Device kind; with device_id.' },
            device_id: { type: 'integer', description: 'Router or OLT id; with kind.' },
            ...SUBSCRIBER_PROPERTIES,
            limit: { type: 'integer', description: 'Tasks to return (at most 50).' },
        },
        deviceTasks,
    ),
    readTool(
        'get_router',
        'Ver router',
        'One router: its last 20 health checks (status, rtt, icmp, cpu/mem when known), circuit-breaker state and WAN capacity. Host credentials are never exposed.',
        { router_id: { type: 'integer', description: 'Router id from list_routers.' } },
        getRouter,
        ['router_id'],
    ),
    readTool(
        'olt_poll_runs',
        'Sondeos de OLT',
        'The last polls of an OLT (status, started/finished, error) and, when known, its current PON status.',
        {
            olt_id: { type: 'integer', description: 'OLT id from list_olts.' },
            limit: { type: 'integer', description: 'Poll runs to return.' },
        },
        oltPollRuns,
        ['olt_id'],
    ),
    readTool(
        'list_eoc_masters',
        'Masters EoC',
        'EoC masters (coaxial/EPON gear): id, name, platform, status / last seen and counted CPEs. Credentials are never exposed; masters are read-only for the agent.',
        { platform_id: { type: 'integer', description: 'Only this platform; default all visible platforms.' } },
        listEocMasters,
    ),
    readTool(
        'live_traffic',
        'Tráfico en vivo',
        'Live traffic of the subscriber\'s PPPoE session, read from the router: {download_bps, upload_bps, sampled_at, source}. It starts a short watch of the session and retries '
        + 'for about 10 s until the first sample; if none arrives it answers {status: "pending"} and you may call it again. It does not change the equipment. '
        + 'Report download_bps and upload_bps (the router-side rx/tx are the other way round).',
        SUBSCRIBER_PROPERTIES,
        liveTraffic,
    ),
    writeTool(
        'reboot_onu',
        'Reiniciar ONU',
        'Reboot the subscriber\'s ONU. The subscriber loses service for a few minutes. Waits up to 110 s (a reboot takes over a minute) and returns the task projection; '
        + 'if it failed, or the ONU never came back (outcome device_error, e.g. onu_offline or restart_not_observed), offer a technical-visit work order (create_work_order).',
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
        + 'channel. Waits up to 110 s and returns the task projection; sync_template_missing means the model is not adapted. '
        + 'NEVER report success from the dispatch alone: it succeeded only when the answer has no outcome (a device_error/task_failed outcome, provisioned false or outcome failed means it FAILED: say so with the reason; check verification.pppoe_user_on_onu, credentials_pushed and ppp_session_up). '
        + 'It never rotates the PPPoE password by itself: pppoe_pass_invalid means the stored password is invalid; ask the operator to confirm rotation before retrying with rotate_pppoe_password true. If the answer has credential_rotated true, tell the operator the PPPoE password changed.',
        {
            ...SUBSCRIBER_PROPERTIES,
            rotate_pppoe_password: { type: 'boolean', description: 'DANGEROUS: changes the subscriber\'s PPPoE password. Set true ONLY after the operator explicitly confirmed it (e.g. after a pppoe_pass_invalid refusal); never by default.' },
        },
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
        + 'subscriber. Optionally opens a linked work order using the idempotency_key as external_ref (a key longer than 100 characters is replaced by a '
        + 'digest of it, the same every time); the work order is only opened when the disconnect is accepted.',
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
    writeTool(
        'update_work_order_status',
        'Cambiar el estado de una orden de trabajo',
        'Change a work order\'s status (POST /work-orders/{id}/status): in_progress to start a pending order, completed to finish a non-installation order, '
        + 'cancelled with a reason. Only the transitions the server allows are accepted; anything else answers illegal_transition and changes nothing. '
        + 'An installation is NEVER completed this way: it closes from the installation closing form (seal number required), so that call answers validation_failed. '
        + 'Asking for the status the order already has returns replayed true and changes nothing.',
        {
            work_order_id: { type: 'integer', description: 'Work order id, from find_work_orders or create_work_order.' },
            status: { type: 'string', enum: WORK_ORDER_STATUS_TARGETS, description: 'Target status: in_progress, completed or cancelled.' },
            reason: { type: 'string', description: 'Required to cancel: why the order is cancelled, at most 500 characters. Ask the operator.' },
        },
        ['work_order_id', 'status'],
        updateWorkOrderStatus,
    ),
    writeTool(
        'set_onu_admin_state',
        'Estado administrativo de la ONU',
        'Enable or disable the subscriber\'s ONU on the OLT (olt.onu_admin_state). Disabling cuts the subscriber\'s service until the ONU is enabled again. '
        + 'Waits up to 40 s and returns the task projection.',
        {
            ...SUBSCRIBER_PROPERTIES,
            admin_state: { type: 'string', enum: ['enable', 'disable'], description: 'Target administrative state.' },
        },
        ['admin_state'],
        setOnuAdminState,
    ),
    writeTool(
        'factory_reset_onu',
        'Restablecer ONU de fábrica',
        'Factory-reset the subscriber\'s ONU: it loses its WAN, WiFi and TR-069 configuration and the subscriber has no service until reprovision_onu runs. '
        + 'Last resort; the operator must confirm it explicitly and you must pass confirm "factory_reset". Waits up to 110 s and returns the task projection.',
        {
            ...SUBSCRIBER_PROPERTIES,
            confirm: { type: 'string', enum: ['factory_reset'], description: 'The literal text factory_reset, only after the operator explicitly confirmed this action.' },
        },
        ['confirm'],
        factoryResetOnu,
        true,
    ),
    writeTool(
        'optimize_wifi',
        'Optimizar WiFi',
        'Optimize the WiFi channel, width and power of the subscriber\'s ONU (onu.wifi_optimize); SSID, password, security and visibility are never touched. '
        + 'mode preview only computes the plan (result.plan, at most 8 items {control, band, from, to}) and NEVER changes the equipment: run it first and show the plan. '
        + 'mode apply writes the plan: pass result.plan back unchanged as plan, after the operator confirmed it. Waits up to 40 s and returns the task projection.',
        {
            ...SUBSCRIBER_PROPERTIES,
            mode: { type: 'string', enum: ['preview', 'apply'], description: 'preview computes the plan and changes nothing; apply writes the plan.' },
            plan: {
                type: 'array',
                items: { type: 'object', description: '{control, band, from, to} item of the preview plan.' },
                description: 'Required with apply: result.plan of the preview, unchanged. Not allowed with preview.',
            },
        },
        ['mode'],
        optimizeWifi,
    ),
    writeTool(
        'restore_wifi',
        'Restaurar WiFi',
        'Write the WiFi CloudISP has on record for the subscriber (SSID, security and password per band) back onto the ONU (onu.wifi_restore), '
        + 'e.g. when the ONU lost or changed it. Waits up to 40 s and returns the task projection.',
        SUBSCRIBER_PROPERTIES,
        [],
        restoreWifi,
    ),
    writeTool(
        'reprovision_onu',
        'Reaprovisionar ONU',
        'Re-provision the subscriber\'s linked ONU (onu.provision, mode reprovision): replays the desired PPPoE WAN, management WAN, TR-069 client, WiFi and CATV onto it, '
        + 'e.g. after a factory reset. The subscriber may lose service briefly. Waits up to 110 s and returns the task projection; a device_error outcome or provisioned false means it FAILED (report the reason). '
        + 'It never changes the PPPoE password; verification.credentials_pushed says whether the ONU received it.',
        SUBSCRIBER_PROPERTIES,
        [],
        reprovisionOnu,
    ),
    writeTool(
        'kick_pppoe',
        'Cerrar sesión PPPoE',
        'Close the subscriber\'s active PPPoE session so the router drops it and the CPE reconnects (a short interruption). Answers {outcome: "disconnected"}; '
        + 'no_active_session when there is no session; kick_unavailable when the RADIUS server cannot do it.',
        SUBSCRIBER_PROPERTIES,
        [],
        kickPppoe,
        true,
    ),
    writeTool(
        'locate_new_onu',
        'Ubicar ONU nueva',
        'First step of an ONU swap: find the replacement ONU by its MAC on the OLTs of the subscriber\'s platform. Waits up to 40 s for every OLT and returns '
        + '{matches: [{olt_id, olt_name, network_onu_id, serial, pon_slot, pon_port, onu_index, model, state, linked_client_id}], olts, errors}. '
        + 'Pass network_onu_id and serial of the match to swap_onu. It reads the OLTs only.',
        {
            ...SUBSCRIBER_PROPERTIES,
            mac: { type: 'string', description: 'MAC of the new ONU: 12 hexadecimal characters, separators allowed.' },
            olt_id: { type: 'integer', description: 'Only search this OLT (id from list_olts) instead of every OLT of the subscriber\'s platform.' },
        },
        ['mac'],
        locateNewOnu,
    ),
    writeTool(
        'swap_onu',
        'Cambiar ONU',
        'Swap the subscriber\'s ONU for the new one found by locate_new_onu: provisions it with the subscriber\'s PPPoE/management/WiFi configuration and relinks the subscriber. '
        + 'The subscriber loses service while it happens. Waits up to 110 s and returns the task projection. Refusals: invalid_mac, onu_not_found, onu_serial_mismatch, onu_mac_mismatch, onu_belongs_to_other_client.',
        {
            ...SUBSCRIBER_PROPERTIES,
            network_onu_id: { type: 'integer', description: 'network_onu_id of the match found by locate_new_onu.' },
            serial: { type: 'string', description: 'serial of that same match.' },
            mac: { type: 'string', description: 'MAC of the new ONU, as given to locate_new_onu.' },
            ssid_24: { type: 'string', description: 'Optional 2.4 GHz network name for the new ONU.' },
            ssid_5: { type: 'string', description: 'Optional 5 GHz network name for the new ONU.' },
            wifi_password: { type: 'string', description: 'Optional new WiFi password; never echoed.' },
            keep_password: { type: 'boolean', description: 'Keep the WiFi password CloudISP has on record for the subscriber.' },
            rotate_pppoe_password: { type: 'boolean', description: 'DANGEROUS: changes the subscriber\'s PPPoE password. Set true ONLY after the operator explicitly confirmed it (e.g. after a pppoe_pass_invalid refusal); never by default.' },
        },
        ['network_onu_id', 'serial', 'mac'],
        swapOnu,
    ),
];

// Every tool carries its user-facing catalogue entry (see lib/guide.mjs); the tests fail when one is missing.
for (const tool of TOOLS) {
    tool.guide = GUIDE[tool.name];
}

/**
 * The tools with their guide entry, for `npm run guide` and the tests.
 *
 * @return {Array<{ name: string, write: boolean, guide: object|undefined }>}
 */
export function guideCatalog() {
    return TOOLS.map(({ name, write, guide }) => ({ name, write: write === true, guide }));
}

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

// ─── Dates ───────────────────────────────────────────────────────────────────

/** Time zone every date handed to the model is shown in (the API speaks UTC). */
const DISPLAY_TIME_ZONE = 'America/Argentina/Salta';

/** ISO 8601 instant with an explicit zone: `Z`, `+00:00`, `-0300`, `+00`. Group 1 is the zone. */
const ZONED_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/** `YYYY-MM-DD HH:MM:SS`: how the database serializes a timestamp without a zone, always UTC. */
const NAIVE_UTC_DATE_PATTERN = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

const DISPLAY_FORMAT = new Intl.DateTimeFormat('en-US', {
    timeZone: DISPLAY_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
});

/**
 * Convert a date string of the API to `America/Argentina/Salta` (`YYYY-MM-DDTHH:MM:SS-03:00`).
 *
 * Converts an ISO 8601 instant with a zone, and `YYYY-MM-DD HH:MM:SS` (no zone = UTC). Anything else,
 * including date-only strings and impossible dates, comes back untouched. Fractional seconds are dropped.
 *
 * @param {unknown} value Candidate value.
 * @return {unknown} The converted string, or the value itself.
 */
export function toDisplayTime(value) {
    if (typeof value !== 'string') {
        return value;
    }

    let instant;
    const zoned = ZONED_DATE_PATTERN.exec(value);
    const naive = NAIVE_UTC_DATE_PATTERN.exec(value);

    if (zoned !== null) {
        // `Date.parse` only takes `Z` or `+HH:MM`; the API may also send `+00` or `+0000`.
        const zone = zoned[1].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2').replace(/^([+-]\d{2})$/, '$1:00');
        instant = Date.parse(value.slice(0, value.length - zoned[1].length) + zone);
    } else if (naive !== null) {
        instant = Date.parse(`${naive[1]}T${naive[2]}Z`);
    } else {
        return value;
    }

    // `Date.parse` rolls 2026-02-31 over to March: an impossible day is not a date.
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);

    if (Number.isNaN(instant) || new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) {
        return value;
    }

    const parts = Object.fromEntries(DISPLAY_FORMAT.formatToParts(instant).map((part) => [part.type, part.value]));
    const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const offsetMinutes = Math.round((local - Math.floor(instant / 1000) * 1000) / 60000);
    const absolute = Math.abs(offsetMinutes);
    const zoneName = `${offsetMinutes < 0 ? '-' : '+'}${String(Math.trunc(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;

    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${zoneName}`;
}

/**
 * Deep copy of a tool payload with every date string converted by {@link toDisplayTime}.
 *
 * @param {unknown} value Payload (or a part of it).
 * @return {unknown} The converted copy.
 */
function localizeDates(value) {
    if (typeof value === 'string') {
        return toDisplayTime(value);
    }

    if (Array.isArray(value)) {
        return value.map(localizeDates);
    }

    return isPlainObject(value)
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, localizeDates(item)]))
        : value;
}

// ─── Outcomes ────────────────────────────────────────────────────────────────

/** Short Spanish instruction to the model per outcome; anything else gets {@link DEFAULT_HINT}. */
const DEFAULT_HINT = 'Informalo al usuario; no reintentes.';
const OUTCOME_HINTS = {
    not_found: 'Dato no disponible: decilo así.',
    task_not_found: 'Dato no disponible: decilo así.',
    source_unavailable: 'Dato no disponible: decilo así.',
    operator_required: 'No se pudo identificar al operador; la acción no se ejecutó.',
    validation_failed: 'Argumentos inválidos: corregilos o preguntale al usuario; no repitas la misma llamada.',
    wifi_read_pending: 'La lectura no terminó y no se escribió nada; consultá get_task más tarde.',
    task_failed: 'La tarea falló en el equipo: informá el motivo y ofrecé la alternativa (reinicio u OT); no reintentes solo.',
    device_error: 'La tarea terminó pero el equipo NO quedó como se pidió (ver error/reason): decí que FALLÓ y el motivo, nunca "sincronizado"; ofrecé la alternativa (reinicio u OT de visita); no reintentes solo.',
    pppoe_pass_invalid: 'La contraseña PPPoE guardada del abonado no es válida y NO se tocó nada. Pedile al operador que confirme explícitamente rotarla (cambia la contraseña PPPoE del abonado) o que la corrija; solo con su confirmación repetí la llamada con rotate_pppoe_password true.',
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
 * The reason a `succeeded` device task did not do what was asked, or `null` when it did.
 *
 * The worker finishes the task fine and reports the failure inside the result: an `error` (e.g.
 * `onu_offline`) or `restart_observed: false` (the ONU never came back from the reboot).
 *
 * @param {object} task Task projection.
 * @return {string|null} Error code, or null.
 */
function deviceFailure(task) {
    if (task.status !== 'succeeded' || !isPlainObject(task.result)) {
        return null;
    }

    const { error, restart_observed: restartObserved } = task.result;

    if (error !== undefined && error !== null && error !== '' && error !== false) {
        return typeof error === 'string' ? error : 'device_error';
    }

    // Admin's normalized outcome (and `provisioned: false`) wins over a bare `status: succeeded`.
    if (task.outcome === 'failed' || task.result.outcome === 'failed' || task.result.provisioned === false || task.provisioned === false) {
        return task.reason ?? task.result.reason ?? 'not_provisioned';
    }

    return restartObserved === false ? 'restart_not_observed' : null;
}

/**
 * Turn expected domain answers into outcomes so they do not count as tool errors.
 *
 * Outcomes: HTTP 4xx (except 401) and 503 `source_unavailable` carrying an API error code, the
 * MCP's own refusals (validation, ambiguity, writes disabled, WiFi read pending), failed device
 * tasks and `succeeded` tasks whose result reports a device error (see {@link deviceFailure}).
 * Transport failures, 401, other 5xx, non-JSON answers and unknown tools stay errors.
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

    const deviceError = deviceFailure(result);

    if (deviceError !== null) {
        return outcomeResult('device_error', result.message, result.result, {
            error: deviceError,
            task_run_id: result.task_run_id ?? null,
            ...(result.reason === undefined ? {} : { reason: result.reason }),
            ...(result.credential_rotated === undefined ? {} : { credential_rotated: result.credential_rotated }),
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
    return localizeDates(classifyOutcome(await dispatchRaw(name, args, fetchImpl, env, clock)));
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

    // `_operator` is not in any inputSchema: the agent runtime adds it, and it never reaches the handler.
    const { _operator: rawOperator, ...toolArgs } = args;
    const operator = readOperator(rawOperator);

    if (tool.write && env?.CLOUDISP_REQUIRE_OPERATOR === '1' && operator === null) {
        return { error: 'operator_required', message: 'The operator could not be identified (hidden _operator argument missing or malformed); nothing was sent to the API.' };
    }

    try {
        return await tool.handler(toolArgs, withHeaders(fetchImpl, identityHeaders(name, operator)), clock, env);
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
    // An outcome (ok:false + outcome) is an expected answer, even when it carries an `error` code (device_error).
    const outcome = isPlainObject(result) && result.ok === false && typeof result.outcome === 'string';
    const isError = isPlainObject(result) && !outcome && (typeof result.error === 'string' || (result.success === false && !unfinished));

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
