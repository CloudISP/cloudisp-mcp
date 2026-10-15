"""Commercial layer of the CloudISP assistant on top of the agent runtime.

Everything the runtime does not offer as configuration lives here, as plain functions the
`__init__.register` wires to hooks: the command allowlist and the usage cut-off, `/guia`, the
operator identity on every MCP call, human approval of every write, the usage ledger, and the
scrubbing of runtime facts (brand, model, host) from what the model reads and says.

Nothing here imports the runtime at module level, so the tests run without it.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.request
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger("cloudisp")

HERE = Path(__file__).resolve().parent

DEFAULT_SETTINGS: dict[str, Any] = {
    "env_file": "",
    "tenant_name": "tu empresa",
    "bot_name": "Asistente CloudISP",
    "mcp_server": "cloudisp",
    "allowed_commands": ["new", "guia", "start"],
}

BLOCKED_COMMAND = "cloudisp-blocked"
QUOTA_COMMAND = "cloudisp-quota"
BLOCKED_TEXT = "Ese comando no está disponible. Escribí /guia para ver todo lo que puedo hacer."
QUOTA_EXHAUSTED_TEXT = (
    "⛔ Se agotó el cupo de uso del Asistente CloudISP para este período. "
    "Contactá a tu administrador de CloudISP."
)
QUOTA_WARNING_TEXT = "⚠️ El Asistente CloudISP ya usó más del 80% del cupo de este período."
SUBAGENT_WRITE_TEXT = (
    "Los subagentes sólo pueden consultar; la acción la tiene que pedir el asistente principal con confirmación."
)
NEUTRAL_RESET_TEXT = "✨ Conversación nueva. Escribí /guia para ver lo que puedo hacer."

# Strings the runtime itself says in chat (session reset banner, model/provider/context lines, tips,
# progress lines with raw tool names, unknown commands). Registered as a language pack for `es` and
# `en`, so the user never reads the model, the provider or an internal tool name.
LOCALE_OVERRIDES: dict[str, str] = {
    "gateway.reset.header_default": NEUTRAL_RESET_TEXT,
    "gateway.reset.header_new": NEUTRAL_RESET_TEXT,
    "gateway.reset.tip": "",
    "gateway.session.info_model": "",
    "gateway.session.info_provider": "",
    "gateway.session.info_context": "",
    "gateway.session.info_acting_model": "",
    "gateway.session.info_endpoint": "",
    "gateway.session.auto_reset_notice": "◐ La conversación se reinició por inactividad. Escribí /guia para ver lo que puedo hacer.",
    "gateway.progress.tool_preview": "{emoji} Consultando CloudISP…",
    "gateway.progress.tool_pending": "{emoji} Consultando CloudISP…",
    "gateway.unknown_command": BLOCKED_TEXT,
    "gateway.notify.no_home_channel": "",
}

CACHE_DIR_ENV = "CLOUDISP_PLUGIN_CACHE_DIR"
QUOTA_TTL_SECONDS = 60.0
QUOTA_ERROR_TTL_SECONDS = 15.0
HTTP_TIMEOUT_SECONDS = 3.0
SPOOL_FLUSH_LIMIT = 50


def cache_dir() -> Path:
    """Directory of the spool and the warned-period markers (`~/.cache/cloudisp-plugin`)."""
    configured = os.environ.get(CACHE_DIR_ENV, "").strip()
    path = Path(configured) if configured else Path.home() / ".cache" / "cloudisp-plugin"
    path.mkdir(parents=True, exist_ok=True)

    return path


def _slug(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value or "") or "default"


# ─── runtime seams ───────────────────────────────────────────────────────────

try:  # the runtime's task-local session variables
    from gateway.session_context import get_session_env
except Exception:  # pragma: no cover - outside the runtime
    def get_session_env(name: str, default: str = "") -> str:
        return os.environ.get(name, default)


def _read_yaml(path: Path) -> dict:
    try:
        import yaml
    except ImportError:  # pragma: no cover - the runtime ships its own loader
        import hermes_yaml as yaml
    with path.open(encoding="utf-8") as handle:
        return yaml.safe_load(handle) or {}


def _config_path(profile: str) -> Path | None:
    """`config.yaml` of a profile; with no profile, of the active home."""
    profile = (profile or "").strip()

    try:
        if profile and profile != "default":
            from hermes_cli.profiles import get_profile_dir

            return Path(get_profile_dir(profile)) / "config.yaml"

        from hermes_constants import get_hermes_home

        return Path(get_hermes_home()) / "config.yaml"
    except Exception:
        return None


_settings_cache: dict[Path, tuple[float, dict]] = {}


def settings_for(profile: str = "") -> dict[str, Any]:
    """`plugins.entries.cloudisp.settings` of a profile over the defaults.

    The gateway dispatches inbound messages and slash commands from the host home, not from the
    profile that owns the bot, so the profile is read from its own `config.yaml`.
    """
    merged = dict(DEFAULT_SETTINGS)
    path = _config_path(profile)

    if path is None or not path.is_file():
        return merged

    try:
        mtime = path.stat().st_mtime
        cached = _settings_cache.get(path)

        if cached is None or cached[0] != mtime:
            entry = ((_read_yaml(path).get("plugins") or {}).get("entries") or {}).get("cloudisp") or {}
            _settings_cache[path] = (mtime, dict(entry.get("settings") or {}))

        merged.update({key: value for key, value in _settings_cache[path][1].items() if value not in (None, "")})
    except Exception as error:
        log.warning("cloudisp: cannot read settings of profile %r: %s", profile or "(active)", error)

    return merged


def session_profile() -> str:
    """Profile of the running turn or command, from the task-local session variables."""
    return get_session_env("HERMES_SESSION_PROFILE", "") or ""


# ─── credentials and HTTP ────────────────────────────────────────────────────


def read_env_file(path: str) -> dict[str, str]:
    """`KEY=VALUE` lines of the MCP's env file. Values are never logged."""
    values: dict[str, str] = {}

    if not path:
        return values

    try:
        lines = Path(path).expanduser().read_text(encoding="utf-8").splitlines()
    except OSError as error:
        log.warning("cloudisp: cannot read env_file: %s", error.strerror or error)

        return values

    for line in lines:
        line = line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, _, value = line.removeprefix("export ").partition("=")
        values[key.strip()] = value.strip().strip("'\"")

    return values


def api_credentials(settings: dict[str, Any]) -> tuple[str, str] | None:
    """`(base, key)` of the admin API, or None when the plugin cannot reach it."""
    env = read_env_file(str(settings.get("env_file") or ""))
    base = (env.get("CLOUDISP_API_BASE") or "").rstrip("/")
    key = env.get("CLOUDISP_API_KEY") or ""

    if not base or not key or key.startswith("op://"):
        return None

    if not (base.startswith("https://") or base.startswith(("http://localhost", "http://127.0.0.1"))):
        return None

    return base, key


class ApiError(Exception):
    """An admin API call that did not succeed; `retry` says whether the same call may work later."""

    def __init__(self, message: str, retry: bool) -> None:
        super().__init__(message)
        self.retry = retry


def api_call(settings: dict[str, Any], method: str, path: str, body: dict | None = None, headers: dict | None = None) -> dict:
    """One call to `/api/v1/public<path>`; returns the `data` of the envelope."""
    credentials = api_credentials(settings)

    if credentials is None:
        raise ApiError("admin API credentials are not available", retry=False)

    base, key = credentials
    request = urllib.request.Request(
        f"{base}/api/v1/public{path}",
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "User-Agent": "cloudisp-hermes-plugin/0.5.0",  # the default urllib agent is refused by some edge filters
            **({"Content-Type": "application/json"} if body is not None else {}),
            **(headers or {}),
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:  # noqa: S310 - https or loopback only
            payload = json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        raise ApiError(f"HTTP {error.code}", retry=error.code in (408, 429) or error.code >= 500) from error
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise ApiError(type(error).__name__, retry=True) from error

    if not isinstance(payload, dict) or payload.get("success") is False:
        raise ApiError("API refused the call", retry=False)

    return payload.get("data") or {}


# ─── usage cut-off ───────────────────────────────────────────────────────────

_quota_cache: dict[str, tuple[float, float, dict | None]] = {}
_quota_lock = threading.Lock()


def quota_status(profile: str, settings: dict[str, Any], now: float | None = None) -> dict | None:
    """`GET /agent/usage/status`, cached 60 s per profile; None when the admin cannot be asked."""
    now = time.monotonic() if now is None else now

    with _quota_lock:
        cached = _quota_cache.get(profile)

        if cached is not None and now - cached[0] < cached[1]:
            return cached[2]

    try:
        status = api_call(settings, "GET", "/agent/usage/status", headers={"X-CloudISP-Tool": "agent_usage_status"})
        ttl = QUOTA_TTL_SECONDS
    except ApiError as error:
        log.warning("cloudisp: usage status unavailable (%s); letting the message through", error)
        status, ttl = None, QUOTA_ERROR_TTL_SECONDS

    with _quota_lock:
        _quota_cache[profile] = (now, ttl, status)

    return status


def warned_marker(profile: str, period: str, period_start: str) -> Path:
    return cache_dir() / f"warned-{_slug(profile)}-{period}-{_slug(period_start)}"


def pending_warning(status: dict | None, profile: str) -> list[Path]:
    """Markers of the periods at 80% or more that were not announced yet."""
    if not status:
        return []

    pending = []

    for period in ("weekly", "monthly"):
        info = status.get(period) or {}
        pct = info.get("pct")

        if isinstance(pct, (int, float)) and pct >= 80 and info.get("period_start"):
            marker = warned_marker(profile, period, str(info["period_start"]))

            if not marker.exists():
                pending.append(marker)

    return pending


# ─── gateway: command allowlist and cut-off ──────────────────────────────────


def _rewrite(text: str) -> dict:
    return {"action": "rewrite", "text": text}


def pre_gateway_dispatch(event: Any = None, gateway: Any = None, session_store: Any = None, **_: Any) -> dict | None:
    """Only the allowed commands reach the runtime; everything else is answered by this plugin.

    The runtime runs this hook before authorization and before any command handler. A refused
    command or an exhausted quota is rewritten to one of the plugin's own commands, so the answer
    goes through the normal reply path (and only to authorized users) and no model is called.
    """
    if event is None:
        return None

    source = getattr(event, "source", None)
    profile = (getattr(source, "profile", None) or "").strip()
    settings = settings_for(profile)
    command = event.get_command() if hasattr(event, "get_command") else None

    if command is not None:
        command = command.replace("_", "-")

        if command == "start":
            return _rewrite("/guia")

        if command in {str(name).lower() for name in settings["allowed_commands"]}:
            return None

        return _rewrite(f"/{BLOCKED_COMMAND}")

    status = quota_status(profile, settings) if api_credentials(settings) else None

    if status and status.get("state") == "exhausted":
        return _rewrite(f"/{QUOTA_COMMAND}")

    return None


def blocked_command(_raw_args: str = "") -> str:
    return BLOCKED_TEXT


def quota_command(_raw_args: str = "") -> str:
    return QUOTA_EXHAUSTED_TEXT.replace("Asistente CloudISP", settings_for(session_profile())["bot_name"], 1)


def guia_command(_raw_args: str = "") -> str:
    """`/guia`: the generated catalogue, answered without the model."""
    settings = settings_for(session_profile())
    text = (HERE / "guia.md").read_text(encoding="utf-8")

    return text.replace("{bot_name}", str(settings["bot_name"])).replace("{tenant_name}", str(settings["tenant_name"]))


# ─── MCP calls: identity, approval, subagents ────────────────────────────────


def load_write_tools() -> dict[str, str]:
    """`{tool: label}` of the write tools, generated by `npm run guide`."""
    data = json.loads((HERE / "write_tools.json").read_text(encoding="utf-8"))

    if not isinstance(data, dict) or not data:
        raise ValueError("write_tools.json must be a non-empty object")

    return {str(name): str(label) for name, label in data.items()}


WRITE_TOOLS: dict[str, str] = {}


def mcp_tool(tool_name: str, server: str) -> str | None:
    """The MCP tool a registered name stands for (`mcp__<server>__<tool>`), else None."""
    prefix = f"mcp__{re.sub(r'[^A-Za-z0-9_]', '_', server)}__"

    return tool_name[len(prefix):] if tool_name.startswith(prefix) else None


def operator_arg(session_id: str = "") -> dict | None:
    """Who is talking, from the session: the hidden `_operator` argument of every MCP call."""
    user_id = get_session_env("HERMES_SESSION_USER_ID", "")

    if not user_id:
        return None

    return {
        "id": str(user_id),
        "name": get_session_env("HERMES_SESSION_USER_NAME", "") or "",
        "channel": get_session_env("HERMES_SESSION_PLATFORM", "") or "cli",
        "conversation": get_session_env("HERMES_SESSION_KEY", "") or session_id or "",
        "profile": get_session_env("HERMES_SESSION_PROFILE", "") or "",
    }


def pre_tool_call_identity(tool_name: str = "", args: dict | None = None, session_id: str = "", **_: Any) -> dict | None:
    """Stamp the operator on every call to the CloudISP MCP server.

    A model-supplied `_operator` is overwritten (with null when the session has no user), so the
    identity always comes from the session.
    """
    if mcp_tool(tool_name, settings_for(session_profile())["mcp_server"]) is None:
        return None

    return {"action": "modify", "args": {"_operator": operator_arg(session_id)}}


_child_sessions: OrderedDict[str, None] = OrderedDict()
_MAX_CHILD_SESSIONS = 1000


def on_subagent_start(child_session_id: str | None = None, **_: Any) -> None:
    if child_session_id:
        _child_sessions[str(child_session_id)] = None

        while len(_child_sessions) > _MAX_CHILD_SESSIONS:
            _child_sessions.popitem(last=False)


def is_subagent(session_id: str = "") -> bool:
    """Whether a tool call comes from a delegated subagent (registered child session or child context)."""
    if session_id and session_id in _child_sessions:
        return True

    try:
        from agent.delegation_context import is_delegated_child_context

        return bool(is_delegated_child_context())
    except Exception:
        return False


ARG_LABELS = {
    "subscriber_id": "Abonado", "subscriber_query": "Abonado", "plan_id": "Plan", "profile_id": "Perfil",
    "download_max_limit": "Bajada máx.", "operation": "Operación", "admin_state": "Estado", "enabled": "Activado",
    "ssid_index": "Red WiFi", "name": "Nombre", "channel": "Canal", "title": "Título", "type": "Tipo",
    "work_order_id": "Orden", "technician_query": "Técnico", "mac": "MAC", "scope": "Alcance", "mode": "Modo",
}
_SECRET_KEY = re.compile(r"pass|psk|secret|token|key|clave", re.IGNORECASE)
_HIDDEN_ARGS = {"_operator", "idempotency_key"}


def summarize_args(args: dict | None, limit: int = 300) -> str:
    """One line with the arguments of a write, secrets masked."""
    parts = []

    for key, value in (args or {}).items():
        if key in _HIDDEN_ARGS or value in (None, "", [], {}):
            continue

        shown = "••••" if _SECRET_KEY.search(key) else (json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value))
        parts.append(f"{ARG_LABELS.get(key, key)}: {shown[:60]}")

    text = " · ".join(parts)

    return text if len(text) <= limit else text[: limit - 1] + "…"


def pre_tool_call_gate(tool_name: str = "", args: dict | None = None, session_id: str = "", **_: Any) -> dict | None:
    """Every write goes to human approval, with a rule key that is never reused.

    A fresh key per call means "approve for the session" or "always" can never approve another
    write. Writes from subagents are refused outright.
    """
    name = mcp_tool(tool_name, settings_for(session_profile())["mcp_server"])

    if name is None or name not in WRITE_TOOLS:
        return None

    if is_subagent(session_id):
        return {"action": "block", "message": SUBAGENT_WRITE_TEXT}

    summary = summarize_args(args)

    return {
        "action": "approve",
        "message": f"✍️ Confirmá: {WRITE_TOOLS[name]}" + (f" — {summary}" if summary else ""),
        "rule_key": f"cloudisp-write-{uuid.uuid4().hex}",
    }


# ─── usage ledger ────────────────────────────────────────────────────────────

_OPERATOR_REF = re.compile(r"^[a-z]{2,16}:[A-Za-z0-9._-]{1,40}$")


def _ascii(value: str, limit: int) -> str:
    folded = unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode()

    return re.sub(r"[\x00-\x1f\x7f]+", " ", folded).strip()[:limit]


def build_usage_event(kw: dict) -> dict | None:
    """The `POST /agent/usage` body of one model call, or None when it consumed nothing."""
    response = kw.get("response")
    usage = kw.get("usage") or (response.get("usage") if isinstance(response, dict) else None) or {}
    tokens = {
        "input_tokens": int(usage.get("input_tokens") or 0),
        "output_tokens": int(usage.get("output_tokens") or 0),
        "cache_read_tokens": int(usage.get("cache_read_tokens") or 0),
        "cache_write_tokens": int(usage.get("cache_write_tokens") or 0),
    }
    model = str(kw.get("model") or "")

    if not model or not any(tokens.values()):
        return None

    session_id = str(kw.get("session_id") or "")
    request_id = str(kw.get("api_request_id") or "") or uuid.uuid4().hex[:12]
    ref = f"{session_id}:{request_id}"
    stamp = kw.get("ended_at") or kw.get("started_at")

    event: dict[str, Any] = {
        "request_ref": ref if len(ref) <= 128 else hashlib.sha1(ref.encode()).hexdigest(),
        "occurred_at": datetime.fromtimestamp(stamp, timezone.utc).isoformat() if isinstance(stamp, (int, float)) else datetime.now(timezone.utc).isoformat(),
        "model": model,
        "provider": str(kw.get("provider") or "unknown"),
        **tokens,
    }
    conversation = _ascii(get_session_env("HERMES_SESSION_KEY", "") or session_id, 128)
    user_id = get_session_env("HERMES_SESSION_USER_ID", "")
    platform = get_session_env("HERMES_SESSION_PLATFORM", "") or "cli"
    operator_ref = f"{platform}:{user_id}" if user_id else ""

    if conversation:
        event["conversation_ref"] = conversation

    if _OPERATOR_REF.match(operator_ref):
        event["operator_ref"] = operator_ref

        if name := _ascii(get_session_env("HERMES_SESSION_USER_NAME", ""), 120):
            event["operator_name"] = name

    return event


def spool_path(profile: str) -> Path:
    return cache_dir() / f"usage-spool-{_slug(profile)}.jsonl"


def _usage_headers(event: dict) -> dict[str, str]:
    headers = {"X-CloudISP-Tool": "agent_usage"}

    if "operator_ref" in event:
        headers["X-CloudISP-Operator-Id"] = event["operator_ref"]
        headers["X-CloudISP-Channel"] = event["operator_ref"].split(":", 1)[0] if event["operator_ref"].split(":", 1)[0] in ("telegram", "cli", "api") else "api"

    if "conversation_ref" in event:
        headers["X-CloudISP-Conversation"] = event["conversation_ref"]

    return headers


def post_usage(settings: dict[str, Any], event: dict) -> str:
    """`ok` (delivered or replayed), `drop` (refused for good: unknown model) or `retry` (try again later)."""
    try:
        api_call(settings, "POST", "/agent/usage", body=event, headers=_usage_headers(event))

        return "ok"
    except ApiError as error:
        if error.retry:
            return "retry"

        log.warning("cloudisp: usage event %s dropped: %s", event.get("request_ref"), error)

        return "drop"


def spool_append(profile: str, event: dict) -> None:
    with spool_path(profile).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")


def flush_spool(profile: str, settings: dict[str, Any], limit: int = SPOOL_FLUSH_LIMIT) -> int:
    """Retry spooled events, at most `limit` per call; returns how many were delivered.

    The file is claimed by renaming it, so two flushes never process the same lines; whatever is
    not delivered goes back to the spool.
    """
    path = spool_path(profile)
    claimed = path.with_name(f"{path.name}.{uuid.uuid4().hex}.claimed")

    try:
        os.replace(path, claimed)
    except FileNotFoundError:
        return 0

    delivered = 0
    leftover: list[str] = []

    try:
        lines = [line for line in claimed.read_text(encoding="utf-8").splitlines() if line.strip()]
        stop = False

        for line in lines:
            if stop or delivered >= limit:
                leftover.append(line)
                continue

            try:
                outcome = post_usage(settings, json.loads(line))
            except ValueError:
                continue

            if outcome == "ok":
                delivered += 1
            elif outcome == "retry":
                leftover.append(line)
                stop = True
    finally:
        if leftover:
            with path.open("a", encoding="utf-8") as handle:
                handle.write("\n".join(leftover) + "\n")

        claimed.unlink(missing_ok=True)

    return delivered


def deliver_usage(profile: str, settings: dict[str, Any], event: dict) -> None:
    outcome = post_usage(settings, event)

    if outcome == "retry":
        spool_append(profile, event)
    elif outcome == "ok":
        flush_spool(profile, settings)


def on_usage(**kw: Any) -> None:
    """`post_api_request` / `post_auxiliary_call`: report the tokens of one model call to the admin.

    The admin prices them. The call goes out from a daemon thread (3 s timeout); a failure spools the
    event and the next call retries it.
    """
    try:
        profile = session_profile()
        settings = settings_for(profile)
        event = build_usage_event(kw)

        if event is None or api_credentials(settings) is None:
            return

        threading.Thread(target=deliver_usage, args=(profile, settings, event), daemon=True, name="cloudisp-usage").start()
    except Exception as error:  # a ledger problem must never break the agent loop
        log.warning("cloudisp: usage report failed: %s", error)


# ─── what the user reads ─────────────────────────────────────────────────────

_BRAND = re.compile(
    r"\b(?:oh my hermes|nous research|open code|hermes|nous|omh|deepseek|opencode|kimi|moonshot|openrouter|anthropic|claude|chatgpt|openai|gpt-?\d*|gemini|qwen)\b",
    re.IGNORECASE,
)
_INFRA_LINE = re.compile(r"hs1|\bct\s*108\b|proxmox|192\.168\.|\blxc\b", re.IGNORECASE)
_MEDIA_TAG = re.compile(r"MEDIA:\S+")
BRAND_REPLACEMENT = "el Asistente CloudISP"


def scrub_output(text: str) -> str:
    """Safety net on what the assistant says: brand and model names become "el Asistente CloudISP"
    and lines that mention the infrastructure are dropped. `MEDIA:` tags are left alone (their path
    must reach the adapter intact). The main rule lives in the identity prompt."""
    media: list[str] = []

    def hide(match: re.Match) -> str:
        media.append(match.group(0))

        return f"\u0000{len(media) - 1}\u0000"

    hidden = _MEDIA_TAG.sub(hide, text)
    lines = [line for line in hidden.split("\n") if not _INFRA_LINE.search(line)]
    scrubbed = _BRAND.sub(BRAND_REPLACEMENT, "\n".join(lines))

    return re.sub("\u0000(\\d+)\u0000", lambda match: media[int(match.group(1))], scrubbed)


def transform_llm_output(response_text: str = "", session_id: str = "", **_: Any) -> str | None:
    """`transform_llm_output`: scrub the reply and, once per period, announce the 80% usage mark."""
    if not isinstance(response_text, str) or not response_text:
        return None

    text = scrub_output(response_text)

    try:
        profile = session_profile()
        settings = settings_for(profile)

        if api_credentials(settings):
            pending = pending_warning(quota_status(profile, settings), profile)

            if pending:
                for marker in pending:
                    marker.touch()

                text = f"{text}\n\n{QUOTA_WARNING_TEXT}"
    except Exception as error:
        log.warning("cloudisp: usage warning skipped: %s", error)

    return text if text != response_text else None


# Runtime facts the model should never read: removed from the prompt it is sent, byte-stable so the
# provider's prompt cache keeps working.
_RUNTIME_BLOCK = re.compile(r"# Hermes runtime environment\n.*?<!-- End Hermes runtime environment -->\n*", re.DOTALL)
_HELP_PARAGRAPH = re.compile(r"(?:^|\n\n)You run on Hermes Agent \(by Nous Research\)\.[^\n]*(?=\n\n|\Z)")
_PROFILE_PARAGRAPH = re.compile(r"(?:^|\n\n)Active Hermes profile:[^\n]*(?=\n\n|\Z)")
_FACTS_TRAILER = re.compile(r"((?:^|\n)Conversation started:[^\n]*(?:\nToday's date[^\n]*)?)(?:\n(?:Session ID|Model|Provider|Platform): [^\n]*)+")
_FIRST_CONTACT_NOTE = re.compile(r"\[System note: This is the user's very first message ever\.[^\]]*\]\s*")
_PROMPT_BRAND = re.compile(r"\b(?:Hermes Agent|Hermes|Nous Research)\b")


def scrub_prompt(text: str) -> str:
    """Drop the runtime's own description of itself (host, model, provider, brand) from a system prompt."""
    text = _RUNTIME_BLOCK.sub("", text)
    text = _HELP_PARAGRAPH.sub("", text)
    text = _PROFILE_PARAGRAPH.sub("", text)
    text = _FACTS_TRAILER.sub(r"\1", text)

    return _PROMPT_BRAND.sub("CloudISP", text)


def _scrub_content(content: Any, scrub) -> tuple[Any, bool]:
    if isinstance(content, str):
        new = scrub(content)

        return new, new != content

    if isinstance(content, list):
        changed = False

        for part in content:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                new = scrub(part["text"])

                if new != part["text"]:
                    part["text"], changed = new, True

        return content, changed

    return content, False


def scrub_request(request: dict | None = None, **_: Any) -> dict | None:
    """`llm_request` middleware: scrub the system prompt (and the first-contact note) of the outgoing request."""
    if not isinstance(request, dict):
        return None

    changed = False

    for message in request.get("messages") or []:
        if not isinstance(message, dict):
            continue

        role = message.get("role")

        if role in ("system", "developer"):
            message["content"], did = _scrub_content(message.get("content"), scrub_prompt)
        elif role == "user":
            message["content"], did = _scrub_content(message.get("content"), lambda value: _FIRST_CONTACT_NOTE.sub("", value))
        else:
            did = False

        changed = changed or did

    for key in ("system", "instructions"):  # Anthropic-style and Responses-style system prompts
        if key in request:
            request[key], did = _scrub_content(request[key], scrub_prompt)
            changed = changed or did

    return {"request": request, "name": "cloudisp-scrub", "reason": "runtime facts removed from the prompt"} if changed else None
