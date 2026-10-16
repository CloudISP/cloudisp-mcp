"""Behaviour of the `cloudisp` plugin, with the runtime stubbed (see conftest.py)."""

import json
import re
import types
from pathlib import Path

import pytest
from conftest import Event

from cloudisp import core, patches, register, strings

PLUGIN_DIR = Path(core.__file__).parent


def status(state="ok", weekly=None, monthly=None):
    period = {"spent_usd": "1.00", "limit_usd": "5.00", "pct": 20, "period_start": "2026-10-12", "period_end": "2026-10-18"}

    return {"weekly": {**period, **(weekly or {})}, "monthly": {**period, "limit_usd": "20.00", "pct": 5, "period_start": "2026-10-01", **(monthly or {})}, "state": state}


@pytest.fixture
def quota(monkeypatch):
    """Answer `GET /agent/usage/status` with whatever the test sets in `answer`."""
    answer = {"value": status()}

    def call(settings, method, path, body=None, headers=None):
        assert (method, path) == ("GET", "/agent/usage/status")

        if isinstance(answer["value"], Exception):
            raise answer["value"]

        return answer["value"]

    monkeypatch.setattr(core, "api_call", call)

    return answer


# ─── commands ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("text", ["/model", "/status", "/usage", "/yolo", "/skills", "/help", "/sethome", "/model@CloudispNVS_bot opus", "/MODEL", "/sessions"])
def test_a_command_outside_the_allowlist_is_answered_by_the_plugin(env, quota, text):
    assert core.pre_gateway_dispatch(Event(text)) == {"action": "rewrite", "text": "/cloudisp-blocked"}
    assert core.blocked_command("") == "Ese comando no está disponible. Escribí /guia para ver todo lo que puedo hacer."


@pytest.mark.parametrize("text", ["/new", "/guia", "/new Algún título", "/NEW@CloudispNVS_bot", "/guia@CloudispNVS_bot"])
def test_the_allowed_commands_go_through(env, quota, text):
    assert core.pre_gateway_dispatch(Event(text)) is None


def test_start_is_rewritten_to_guia(env, quota):
    assert core.pre_gateway_dispatch(Event("/start")) == {"action": "rewrite", "text": "/guia"}


def test_a_command_in_the_profile_settings_is_allowed(env, quota):
    (env / "config.yaml").write_text(
        "plugins:\n  entries:\n    cloudisp:\n      settings:\n        allowed_commands: [new, guia, start, stop]\n"
    )
    core._settings_cache.clear()

    assert core.pre_gateway_dispatch(Event("/stop")) is None
    assert core.pre_gateway_dispatch(Event("/model")) == {"action": "rewrite", "text": "/cloudisp-blocked"}


def test_a_path_is_not_a_command(env, quota):
    assert core.pre_gateway_dispatch(Event("/home/hermes/x revisá esto")) is None


def test_guia_has_only_markup_the_telegram_adapter_renders(env):
    text = core.guia_command("")

    assert "_" not in text, "the adapter escapes underscores, so an italic written with them shows raw"
    assert "*" not in re.sub(r"\*\*[^*\n]+\*\*", "", text), "every asterisk is part of a **bold** pair"
    assert all(re.fullmatch(r"• \*\*[^*]+\*\*( ✍️)? — ejemplo: «[^«»]+»", line) for line in text.splitlines() if line.startswith("• "))


def test_guia_answers_the_catalogue_with_the_bot_and_the_tenant(env):
    text = core.guia_command("")

    assert text.startswith("**👋 Soy el Asistente CloudISP de NVS InterService**")
    assert "{bot_name}" not in text and "{tenant_name}" not in text
    assert "**Reiniciar la ONU** ✍️" in text


# ─── cut-off ─────────────────────────────────────────────────────────────────


def test_an_exhausted_quota_answers_instead_of_calling_the_model(env, quota):
    quota["value"] = status("exhausted", weekly={"pct": 100})

    assert core.pre_gateway_dispatch(Event("hola")) == {"action": "rewrite", "text": "/cloudisp-quota"}
    assert core.quota_command("") == "⛔ Se agotó el cupo de uso del Asistente CloudISP para este período. Contactá a tu administrador de CloudISP."


def test_an_exhausted_quota_still_lets_the_allowed_commands_through(env, quota):
    quota["value"] = status("exhausted")

    assert core.pre_gateway_dispatch(Event("/new")) is None
    assert core.pre_gateway_dispatch(Event("/guia")) is None


@pytest.mark.parametrize("state", ["ok", "warning"])
def test_a_quota_with_room_lets_the_message_through(env, quota, state):
    quota["value"] = status(state)

    assert core.pre_gateway_dispatch(Event("hola")) is None


def test_an_unreachable_admin_lets_the_message_through(env, quota):
    quota["value"] = core.ApiError("URLError", retry=True)

    assert core.pre_gateway_dispatch(Event("hola")) is None


def test_the_quota_is_asked_once_a_minute(env, monkeypatch):
    calls = []
    monkeypatch.setattr(core, "api_call", lambda *args, **kw: calls.append(args) or status())
    settings = core.settings_for("cloudisp-nvs")

    core.quota_status("cloudisp-nvs", settings, now=100.0)
    core.quota_status("cloudisp-nvs", settings, now=159.0)
    core.quota_status("cloudisp-nvs", settings, now=161.0)

    assert len(calls) == 2


def test_without_credentials_no_request_is_made(env, quota, monkeypatch):
    (env / "config.yaml").write_text("plugins:\n  entries:\n    cloudisp:\n      settings:\n        env_file: ''\n")
    core._settings_cache.clear()
    monkeypatch.setattr(core, "api_call", lambda *args, **kw: pytest.fail("no request expected"))

    assert core.pre_gateway_dispatch(Event("hola")) is None


def test_an_op_reference_is_not_used_as_a_key(env):
    (env / "prod.env").write_text("CLOUDISP_API_BASE=https://admin.example.test\nCLOUDISP_API_KEY=op://Vault/Item/credential\n")

    assert core.api_credentials(core.settings_for("cloudisp-nvs")) is None


def test_the_eighty_percent_warning_is_appended_once_per_period(env, quota, session):
    quota["value"] = status("warning", weekly={"pct": 82})

    first = core.transform_llm_output("Listo.", "s1")
    second = core.transform_llm_output("Listo.", "s1")

    assert first == "Listo.\n\n⚠️ El Asistente CloudISP ya usó más del 80% del cupo de este período."
    assert second is None
    assert any(path.name.startswith("warned-cloudisp-nvs-weekly-") for path in core.cache_dir().iterdir())

    quota["value"] = status("warning", weekly={"pct": 82, "period_start": "2026-10-19"})
    core._quota_cache.clear()

    assert core.transform_llm_output("Listo.", "s1").endswith("del cupo de este período.")


# ─── identity ────────────────────────────────────────────────────────────────


def test_every_mcp_call_gets_the_operator_of_the_session(env, session):
    directive = core.pre_tool_call_identity("mcp__cloudisp__find_subscriber", {"query": "#2861"}, "sess-1")

    assert directive == {"action": "modify", "args": {"_operator": {
        "id": "941533777", "name": "Mario Santos", "channel": "telegram",
        "conversation": "sess-1", "profile": "cloudisp-nvs",
    }}}


def test_a_session_without_user_overwrites_any_operator_with_null(env, session):
    session.values.pop("HERMES_SESSION_USER_ID")

    assert core.pre_tool_call_identity("mcp__cloudisp__reboot_onu", {"_operator": {"id": "1", "channel": "telegram"}}, "s") == {
        "action": "modify", "args": {"_operator": None},
    }


def test_the_channel_defaults_to_cli(env, session):
    session.values.pop("HERMES_SESSION_PLATFORM")

    operator = core.pre_tool_call_identity("mcp__cloudisp__find_subscriber", {}, "sess-9")["args"]["_operator"]

    assert (operator["conversation"], operator["channel"]) == ("sess-9", "cli")


# ─── conversation ────────────────────────────────────────────────────────────

CHAT_KEY = "agent:cloudisp-nvs:telegram:dm:941533777"


def test_the_conversation_is_the_session_id_and_changes_with_it_while_the_chat_key_does_not(env, session):
    session.values["HERMES_SESSION_KEY"] = CHAT_KEY

    before = core.pre_tool_call_identity("mcp__cloudisp__find_subscriber", {}, "20261015_195100_aaaa1111")["args"]["_operator"]
    after_new = core.pre_tool_call_identity("mcp__cloudisp__find_subscriber", {}, "20261015_203000_bbbb2222")["args"]["_operator"]

    assert before["conversation"] == "20261015_195100_aaaa1111"
    assert after_new["conversation"] == "20261015_203000_bbbb2222"
    assert CHAT_KEY not in (before["conversation"], after_new["conversation"])


def test_the_usage_event_and_the_operator_agree_on_the_conversation(env, session):
    session.values["HERMES_SESSION_KEY"] = CHAT_KEY
    operator = core.operator_arg("20261015_195100_ab12")
    event = core.build_usage_event(usage_kw())

    assert operator["conversation"] == event["conversation_ref"] == "20261015_195100_ab12"


def test_every_turn_of_one_conversation_reports_the_same_ref_and_a_new_conversation_a_different_one(env, session):
    session.values["HERMES_SESSION_KEY"] = CHAT_KEY
    refs = [core.build_usage_event(usage_kw(session_id=sid, api_request_id=f"turn-{n}:api:1"))["conversation_ref"] for n, sid in enumerate(["s-1", "s-1", "s-1", "s-2", "s-2"])]

    assert refs == ["s-1", "s-1", "s-1", "s-2", "s-2"]


def test_without_a_hook_session_id_the_task_session_id_is_used_then_the_chat_key(env, session):
    session.values["HERMES_SESSION_KEY"] = CHAT_KEY
    session.values["HERMES_SESSION_ID"] = "20261015_210000_cccc3333"

    assert core.conversation_id("") == "20261015_210000_cccc3333"

    session.values["HERMES_SESSION_ID"] = ""

    assert core.conversation_id("") == CHAT_KEY

    session.values.pop("HERMES_SESSION_KEY")

    assert core.conversation_id("") == ""


def test_the_hook_session_id_wins_over_the_task_session_id(env, session):
    session.values["HERMES_SESSION_ID"] = "stale-from-another-turn"

    assert core.conversation_id("20261015_195100_ab12") == "20261015_195100_ab12"


def test_a_subagent_belongs_to_the_conversation_that_delegated_to_it(env, session):
    core.on_subagent_start(child_session_id="child-1", parent_session_id="20261015_195100_ab12")
    core.on_subagent_start(child_session_id="grandchild-1", parent_session_id="child-1")

    assert core.conversation_id("child-1") == core.conversation_id("grandchild-1") == "20261015_195100_ab12"
    assert core.build_usage_event(usage_kw(session_id="child-1"))["conversation_ref"] == "20261015_195100_ab12"
    assert core.build_usage_event(usage_kw(session_id="child-1"))["request_ref"].startswith("child-1:"), "the request ref keeps the agent's own session"

    session.values["HERMES_SESSION_ID"] = "child-1"

    assert core.conversation_id("") == "20261015_195100_ab12"


def test_a_subagent_registered_without_a_parent_keeps_its_own_id_and_a_cycle_terminates(env, session):
    core.on_subagent_start(child_session_id="orphan")
    core.on_subagent_start(child_session_id="a", parent_session_id="b")
    core.on_subagent_start(child_session_id="b", parent_session_id="a")

    assert core.conversation_id("orphan") == "orphan"
    assert core.conversation_id("a") in {"a", "b"}


def test_the_conversation_is_at_most_128_printable_ascii_characters(env, session):
    assert len(core.conversation_id("x" * 300)) == 128
    assert core.conversation_id("ses\nsión\x00 ñ 7") == "ses sion  n 7"
    assert core.conversation_id("a\r\nb\x00c") == "a b c"
    assert core.build_usage_event(usage_kw(session_id="y" * 300))["conversation_ref"] == "y" * 128


@pytest.mark.parametrize("tool", ["terminal", "clarify", "delegate_task", "mcp__other__find_subscriber", "mcp__cloudisp"])
def test_other_tools_are_left_alone(env, session, tool):
    assert core.pre_tool_call_identity(tool, {}, "s") is None
    assert core.pre_tool_call_gate(tool, {}, "s") is None


def test_the_server_name_comes_from_the_settings(env, session):
    (env / "config.yaml").write_text("plugins:\n  entries:\n    cloudisp:\n      settings:\n        mcp_server: cloudisp-prod\n")
    core._settings_cache.clear()

    assert core.pre_tool_call_identity("mcp__cloudisp_prod__find_subscriber", {}, "s")["action"] == "modify"
    assert core.pre_tool_call_identity("mcp__cloudisp__find_subscriber", {}, "s") is None


# ─── approval ────────────────────────────────────────────────────────────────


def test_a_write_asks_for_approval_in_spanish_with_a_rule_key_that_is_never_reused(env, session):
    first = core.pre_tool_call_gate("mcp__cloudisp__reboot_onu", {"subscriber_id": 2861, "idempotency_key": "agent-1", "_operator": {"id": "x"}}, "s")
    second = core.pre_tool_call_gate("mcp__cloudisp__reboot_onu", {"subscriber_id": 2861}, "s")

    assert first["action"] == "approve"
    assert first["message"] == "✍️ Confirmá: Reiniciar la ONU — Abonado: 2861"
    assert re.fullmatch(r"cloudisp-write-[0-9a-f]{32}", first["rule_key"])
    assert first["rule_key"] != second["rule_key"]


def test_a_read_goes_straight_through(env, session):
    assert core.pre_tool_call_gate("mcp__cloudisp__find_subscriber", {"query": "#1"}, "s") is None


def test_the_approval_summary_masks_secrets_and_stays_short(env):
    summary = core.summarize_args({"subscriber_id": 7, "wifi_password": "S3cr3t", "psk": "abc", "api_key": "k", "title": "x" * 500, "note": None})

    assert "S3cr3t" not in summary and "abc" not in summary
    assert "Abonado: 7" in summary and "wifi_password: ••••" in summary
    assert len(summary) <= 300


def test_a_write_from_a_registered_subagent_is_blocked(env, session):
    core.on_subagent_start(child_session_id="child-1", parent_session_id="parent")

    directive = core.pre_tool_call_gate("mcp__cloudisp__reboot_onu", {"subscriber_id": 1}, "child-1")

    assert directive == {"action": "block", "message": "Los subagentes sólo pueden consultar; la acción la tiene que pedir el asistente principal con confirmación."}
    assert core.pre_tool_call_gate("mcp__cloudisp__reboot_onu", {"subscriber_id": 1}, "main")["action"] == "approve"


def test_a_write_inside_the_delegated_child_context_is_blocked(env, session, monkeypatch):
    monkeypatch.setattr(core, "is_subagent", lambda session_id="": True)

    assert core.pre_tool_call_gate("mcp__cloudisp__kick_pppoe", {"subscriber_id": 1}, "any")["action"] == "block"


def test_a_subagent_may_still_read(env, session):
    core.on_subagent_start(child_session_id="child-1")

    assert core.pre_tool_call_gate("mcp__cloudisp__find_subscriber", {"query": "x"}, "child-1") is None


def denial(choice, turn="turn-1", session="sess-1", key="plugin_rule:cloudisp-write-abc"):
    core.on_approval_response(pattern_key=key, choice=choice, session_id=session, turn_id=turn, session_key="agent:main", surface="gateway")


@pytest.mark.parametrize("choice", ["deny", "timeout", "cancelled", "notify_failed"])
def test_after_a_denied_confirmation_the_same_turn_cannot_ask_again(env, session, choice):
    first = core.pre_tool_call_gate("mcp__cloudisp__reboot_onu", {"subscriber_id": 1}, "sess-1", turn_id="turn-1")

    assert first["action"] == "approve"

    denial(choice)

    again = core.pre_tool_call_gate("mcp__cloudisp__reboot_onu", {"subscriber_id": 1}, "sess-1", turn_id="turn-1")
    other = core.pre_tool_call_gate("mcp__cloudisp__kick_pppoe", {"subscriber_id": 1}, "sess-1", turn_id="turn-1")

    assert again == other == {"action": "block", "message": core.DENIED_RETRY_TEXT}
    assert "No la reintentes" in core.DENIED_RETRY_TEXT


def test_a_new_turn_a_new_session_and_the_reads_are_not_affected_by_a_denial(env, session):
    denial("deny")

    assert core.pre_tool_call_gate("mcp__cloudisp__reboot_onu", {"subscriber_id": 1}, "sess-1", turn_id="turn-2")["action"] == "approve"
    assert core.pre_tool_call_gate("mcp__cloudisp__reboot_onu", {"subscriber_id": 1}, "sess-2", turn_id="turn-1")["action"] == "approve"
    assert core.pre_tool_call_gate("mcp__cloudisp__find_subscriber", {"query": "#1"}, "sess-1", turn_id="turn-1") is None


@pytest.mark.parametrize("choice", ["once", "session", "always"])
def test_a_granted_confirmation_does_not_block_the_turn(env, session, choice):
    denial(choice)

    assert core.pre_tool_call_gate("mcp__cloudisp__reboot_onu", {"subscriber_id": 1}, "sess-1", turn_id="turn-1")["action"] == "approve"


def test_the_denial_of_an_approval_that_is_not_ours_is_ignored(env, session):
    denial("deny", key="plugin_rule:other-plugin-rule")
    denial("deny", key="dangerous_command:rm")

    assert core.pre_tool_call_gate("mcp__cloudisp__reboot_onu", {"subscriber_id": 1}, "sess-1", turn_id="turn-1")["action"] == "approve"


def test_without_a_turn_id_there_is_nothing_to_remember(env, session):
    core.on_approval_response(pattern_key="plugin_rule:cloudisp-write-x", choice="deny", session_id="sess-1", turn_id="")

    assert core.pre_tool_call_gate("mcp__cloudisp__reboot_onu", {"subscriber_id": 1}, "sess-1")["action"] == "approve"


def test_the_shipped_write_list_matches_the_catalogue():
    shipped = core.load_write_tools()

    assert "reboot_onu" in shipped and "find_subscriber" not in shipped
    assert all(label for label in shipped.values())


# ─── fail closed ─────────────────────────────────────────────────────────────

RUNTIME_KWARGS = {"task_id": "task-1", "tool_call_id": "call-1", "api_request_id": "turn-1:api:1", "middleware_trace": [], "telemetry_schema_version": "hermes.observer.v1"}


def runtime_decision(tool, args, session_id="sess-1", turn_id="turn-1"):
    """What the runtime does with the plugin's two `pre_tool_call` callbacks (`hermes_cli/plugins.py::_get_pre_tool_call_directive_details`).

    Both run in registration order over the SAME model arguments, with every kwarg the runtime sends; `modify` results shallow-merge
    over those arguments; a `block` beats an `approve`. Unlike the runtime, an exception is not caught here: the callbacks must never raise.
    """
    results = [
        callback(tool_name=tool, args=args, session_id=session_id, turn_id=turn_id, **RUNTIME_KWARGS)
        for callback in (core.pre_tool_call_identity, core.pre_tool_call_gate)
    ]
    results = [result for result in results if result is not None]
    final_args = args

    for result in results:
        if result.get("action") == "modify" and result.get("args"):
            final_args = {**final_args, **result["args"]}

    blocks = [result for result in results if result.get("action") == "block"]
    approves = [result for result in results if result.get("action") == "approve"]
    chosen = (blocks or approves or [{}])[0]

    return types.SimpleNamespace(args=final_args, action=chosen.get("action"), message=chosen.get("message"))


SESSION_OPERATOR = {"id": "941533777", "name": "Mario Santos", "channel": "telegram", "conversation": "sess-1", "profile": "cloudisp-nvs"}
FORGED = [
    {"id": "666", "name": "Mallory", "channel": "telegram", "conversation": "x"},
    "telegram:666",
    ["telegram", "666"],
    {"id": "941533777"},
    None,
    {},
]


@pytest.mark.parametrize("forged", FORGED)
@pytest.mark.parametrize("tool", ["mcp__cloudisp__find_subscriber", "mcp__cloudisp__reboot_onu"])
def test_an_operator_forged_by_the_model_is_replaced_by_the_session_operator(env, session, tool, forged):
    decision = runtime_decision(tool, {"subscriber_id": 1, "_operator": forged})

    assert decision.args["_operator"] == SESSION_OPERATOR
    assert decision.args["subscriber_id"] == 1
    assert decision.action == ("approve" if tool.endswith("reboot_onu") else None)


@pytest.mark.parametrize("forged", FORGED)
def test_without_a_session_user_a_forged_operator_is_stripped_and_a_write_is_blocked(env, session, forged):
    session.values.pop("HERMES_SESSION_USER_ID")

    read = runtime_decision("mcp__cloudisp__find_subscriber", {"query": "x", "_operator": forged})
    write = runtime_decision("mcp__cloudisp__reboot_onu", {"subscriber_id": 1, "_operator": forged})

    assert read.args["_operator"] is None and read.action is None
    assert write.args["_operator"] is None
    assert (write.action, write.message) == ("block", core.OPERATOR_UNKNOWN_TEXT)


@pytest.mark.parametrize("key, value", [
    ("HERMES_SESSION_USER_ID", "a b"), ("HERMES_SESSION_USER_ID", "x" * 41), ("HERMES_SESSION_USER_ID", "941/533"), ("HERMES_SESSION_USER_ID", ""),
    ("HERMES_SESSION_PLATFORM", "Tele gram"), ("HERMES_SESSION_PLATFORM", "t"), ("HERMES_SESSION_PLATFORM", "telegram:1"),
])
def test_an_identity_the_mcp_would_refuse_counts_as_no_identity(env, session, key, value):
    session.values[key] = value

    assert core.operator_arg("sess-1") is None
    assert runtime_decision("mcp__cloudisp__reboot_onu", {"subscriber_id": 1}).action == "block"


def test_the_platform_is_lowercased_like_the_mcp_expects(env, session):
    session.values["HERMES_SESSION_PLATFORM"] = "Telegram"

    assert core.operator_arg("sess-1")["channel"] == "telegram"


def test_the_gate_derives_the_operator_on_its_own(env, session):
    assert core.pre_tool_call_gate("mcp__cloudisp__reboot_onu", {"subscriber_id": 1}, "sess-1")["action"] == "approve"

    session.values.pop("HERMES_SESSION_USER_ID")

    assert core.pre_tool_call_gate("mcp__cloudisp__reboot_onu", {"subscriber_id": 1}, "sess-1") == {"action": "block", "message": core.OPERATOR_UNKNOWN_TEXT}
    assert core.pre_tool_call_gate("mcp__cloudisp__find_subscriber", {"query": "x"}, "sess-1") is None


def test_the_gate_blocks_when_the_identity_callback_succeeded_but_its_own_derivation_fails(env, session, monkeypatch):
    real = core.operator_arg
    calls = []

    def flaky(session_id=""):
        calls.append(session_id)

        if len(calls) > 1:
            raise RuntimeError("session store went away")

        return real(session_id)

    monkeypatch.setattr(core, "operator_arg", flaky)

    assert core.pre_tool_call_identity("mcp__cloudisp__reboot_onu", {}, "sess-1")["args"]["_operator"]["id"] == "941533777"
    assert core.pre_tool_call_gate("mcp__cloudisp__reboot_onu", {"subscriber_id": 1}, "sess-1") == {"action": "block", "message": core.GUARD_ERROR_TEXT}


def boom(*args, **kwargs):
    raise RuntimeError("boom")


@pytest.mark.parametrize("failing", ["operator_arg", "mcp_server_name"])
def test_an_error_while_deriving_the_identity_blocks_every_write_and_strips_every_read(env, session, monkeypatch, caplog, failing):
    monkeypatch.setattr(core, failing, boom)

    with caplog.at_level("ERROR"):
        write = runtime_decision("mcp__cloudisp__reboot_onu", {"subscriber_id": 1, "_operator": FORGED[0]})
        read = runtime_decision("mcp__cloudisp__find_subscriber", {"query": "x", "_operator": FORGED[0]})

    assert (write.action, write.message) == ("block", core.GUARD_ERROR_TEXT)
    assert read.action is None and read.args["_operator"] is None, "a read goes out, but never with the forged identity"
    assert any("CLOUDISP_GUARD_ERROR stage=identity tool=mcp__cloudisp__reboot_onu error=RuntimeError: boom" in message for message in error_records(caplog))


def test_an_error_in_the_gate_alone_blocks_a_write(env, session, monkeypatch, caplog):
    monkeypatch.setattr(core, "summarize_args", boom)

    with caplog.at_level("ERROR"):
        write = runtime_decision("mcp__cloudisp__reboot_onu", {"subscriber_id": 1})
        read = runtime_decision("mcp__cloudisp__find_subscriber", {"query": "x"})

    assert (write.action, write.message) == ("block", core.GUARD_ERROR_TEXT)
    assert write.args["_operator"] == SESSION_OPERATOR
    assert read.action is None and read.args["_operator"] == SESSION_OPERATOR
    assert any("CLOUDISP_GUARD_ERROR stage=gate tool=mcp__cloudisp__reboot_onu" in message for message in error_records(caplog))


def test_an_unreadable_config_falls_back_to_the_default_server_and_keeps_working(env, session, monkeypatch):
    monkeypatch.setattr(core, "settings_for", boom)

    decision = runtime_decision("mcp__cloudisp__reboot_onu", {"subscriber_id": 1, "_operator": FORGED[0]})

    assert decision.args["_operator"] == SESSION_OPERATOR and decision.action == "approve"


def test_when_something_failed_a_write_named_tool_of_any_server_is_blocked_and_other_tools_are_left_alone(env, session, monkeypatch):
    monkeypatch.setattr(core, "mcp_server_name", boom)

    assert runtime_decision("mcp__cloudisp_prod__kick_pppoe", {"subscriber_id": 1}).action == "block"
    assert runtime_decision("mcp__other__find_user", {"q": 1, "_operator": "keep"}).args["_operator"] == "keep"
    assert runtime_decision("terminal", {"command": "ls"}).action is None


@pytest.mark.parametrize("tool", [None, 5, "", [], {"name": "x"}])
def test_a_tool_name_that_is_not_a_string_never_raises(env, session, tool):
    assert core.pre_tool_call_identity(tool, {}, "s") is None
    assert core.pre_tool_call_gate(tool, {}, "s") is None
    assert core.mcp_tool(tool, "cloudisp") is None


def test_a_session_error_blocks_a_write_even_when_the_session_variables_raise(env, monkeypatch):
    monkeypatch.setattr(core, "get_session_env", boom)

    assert runtime_decision("mcp__cloudisp__reboot_onu", {"subscriber_id": 1}).action == "block"
    assert runtime_decision("mcp__cloudisp__find_subscriber", {"q": 1, "_operator": FORGED[0]}).args["_operator"] is None


# ─── usage ledger ────────────────────────────────────────────────────────────


def usage_kw(**extra):
    return {
        "session_id": "20261015_195100_ab12", "api_request_id": "turn-1:api:1", "model": "deepseek-v4.1-flash", "provider": "opencode-go",
        "started_at": 1792101060.0, "ended_at": 1792101062.5,
        "usage": {"input_tokens": 1200, "output_tokens": 340, "cache_read_tokens": 5100, "cache_write_tokens": 0, "reasoning_tokens": 80},
        **extra,
    }


def test_the_usage_event_carries_tokens_model_and_who_asked(env, session):
    event = core.build_usage_event(usage_kw())

    assert event == {
        "request_ref": "20261015_195100_ab12:turn-1:api:1",
        "occurred_at": "2026-10-15T21:51:02.500000+00:00",
        "model": "deepseek-v4.1-flash", "provider": "opencode-go",
        "input_tokens": 1200, "output_tokens": 340, "cache_read_tokens": 5100, "cache_write_tokens": 0,
        "conversation_ref": "20261015_195100_ab12", "operator_ref": "telegram:941533777", "operator_name": "Mario Santos",
    }


def test_the_usage_comes_from_the_response_when_there_is_no_usage_kwarg(env, session):
    kw = usage_kw(response={"usage": {"input_tokens": 3, "output_tokens": 4}})
    kw.pop("usage")

    assert core.build_usage_event(kw)["output_tokens"] == 4


def test_a_call_without_tokens_or_model_reports_nothing(env, session):
    assert core.build_usage_event(usage_kw(usage={})) is None
    assert core.build_usage_event(usage_kw(model="")) is None


def test_a_long_request_ref_is_hashed_to_128_characters(env, session):
    assert len(core.build_usage_event(usage_kw(api_request_id="x" * 300))["request_ref"]) == 40


def test_a_failed_report_is_spooled_and_retried_by_the_next_one(env, session, monkeypatch):
    sent = []
    outcomes = iter([core.ApiError("URLError", retry=True), None, None])

    def call(settings, method, path, body=None, headers=None):
        outcome = next(outcomes)

        if outcome is not None:
            raise outcome

        sent.append(body["request_ref"])

        return {"cost_usd": "0.000100"}

    monkeypatch.setattr(core, "api_call", call)
    settings = core.settings_for("cloudisp-nvs")
    first = core.build_usage_event(usage_kw(api_request_id="a"))
    second = core.build_usage_event(usage_kw(api_request_id="b"))

    core.deliver_usage("cloudisp-nvs", settings, first)

    spooled = [json.loads(line) for line in core.spool_path("cloudisp-nvs").read_text().splitlines()]
    assert [event["request_ref"] for event in spooled] == [first["request_ref"]] and sent == []

    core.deliver_usage("cloudisp-nvs", settings, second)

    assert sent == [second["request_ref"], first["request_ref"]]
    assert not core.spool_path("cloudisp-nvs").exists()


def test_a_flush_retries_at_most_fifty_events(env, session, monkeypatch):
    monkeypatch.setattr(core, "api_call", lambda *args, **kw: {})

    for number in range(70):
        core.spool_append("cloudisp-nvs", {"request_ref": f"r{number}", "model": "m"})

    assert core.flush_spool("cloudisp-nvs", core.settings_for("cloudisp-nvs")) == 50
    assert len(core.spool_path("cloudisp-nvs").read_text().splitlines()) == 20


def test_a_flush_stops_at_the_first_failure_and_keeps_the_rest(env, session, monkeypatch):
    answers = iter([{}, core.ApiError("timeout", retry=True)])

    def call(*args, **kw):
        answer = next(answers)

        if isinstance(answer, Exception):
            raise answer

        return answer

    monkeypatch.setattr(core, "api_call", call)

    for number in range(4):
        core.spool_append("cloudisp-nvs", {"request_ref": f"r{number}"})

    assert core.flush_spool("cloudisp-nvs", core.settings_for("cloudisp-nvs")) == 1
    assert [json.loads(line)["request_ref"] for line in core.spool_path("cloudisp-nvs").read_text().splitlines()] == ["r1", "r2", "r3"]


def test_an_event_the_admin_refuses_for_good_is_dropped_not_spooled(env, session, monkeypatch):
    monkeypatch.setattr(core, "api_call", lambda *args, **kw: (_ for _ in ()).throw(core.ApiError("HTTP 422", retry=False)))

    core.deliver_usage("cloudisp-nvs", core.settings_for("cloudisp-nvs"), core.build_usage_event(usage_kw()))

    assert not core.spool_path("cloudisp-nvs").exists()


def test_on_usage_never_raises(env, session, monkeypatch):
    monkeypatch.setattr(core, "build_usage_event", lambda kw: (_ for _ in ()).throw(RuntimeError("boom")))

    core.on_usage(**usage_kw())


# ─── what the user reads ─────────────────────────────────────────────────────


@pytest.mark.parametrize("brand", ["Hermes", "hermes", "Nous Research", "Oh My Hermes", "OMH", "DeepSeek", "opencode", "Open Code", "Kimi", "Moonshot", "OpenRouter", "Anthropic", "Claude", "OpenAI", "GPT-4", "gpt5", "ChatGPT", "Qwen"])
def test_brands_become_the_assistant(brand):
    assert core.scrub_output(f"Soy {brand} y te ayudo.") == "Soy el Asistente CloudISP y te ayudo."


def test_a_word_that_only_contains_a_brand_is_left_alone():
    assert core.scrub_output("El abonado Kimiko y el canal omhz siguen igual.") == "El abonado Kimiko y el canal omhz siguen igual."


def test_lines_about_the_infrastructure_are_dropped():
    text = "Listo.\nCorro en hs1, CT 108.\nEl proxmox está bien\nIP 192.168.88.5\nUn LXC más\nFin."

    assert core.scrub_output(text) == "Listo.\nFin."


def test_a_media_tag_keeps_its_path_intact():
    text = "Acá va el informe:\nMEDIA:/home/hermes/.cache/cloudisp-artifacts/informe-hermes-20261015.html\nDeepSeek no."

    assert core.scrub_output(text) == "Acá va el informe:\nMEDIA:/home/hermes/.cache/cloudisp-artifacts/informe-hermes-20261015.html\nel Asistente CloudISP no."


def test_transform_llm_output_changes_only_what_it_must(env, session):
    assert core.transform_llm_output("Todo bien.", "s") is None
    assert core.transform_llm_output("Soy Hermes.", "s") == "Soy el Asistente CloudISP."
    assert core.transform_llm_output("", "s") is None


PROMPT = (
    "# Asistente\n\nSos el Asistente CloudISP.\n\n"
    "You run on Hermes Agent (by Nous Research). When the user needs help with Hermes itself — configuring, setting up.\n\n"
    "Mid-turn, the user can steer you: Hermes delivers their message as a standalone user message.\n\n"
    "Active Hermes profile: cloudisp-nvs. This session reads and writes /home/hermes/.hermes/profiles/cloudisp-nvs/. Do NOT modify another.\n\n"
    "Conversation started: Thursday, October 15, 2026 (America/Argentina/Salta, UTC-03:00)\n"
    "Model: deepseek-v4.1-flash\nProvider: opencode-go\nPlatform: telegram\n\n"
    "# Hermes runtime environment\n\nHost: Linux (6.17.2-2-pve)\nUser home directory: /home/hermes\nCurrent working directory: /home/hermes\n\n"
    "<!-- End Hermes runtime environment -->"
)


def test_the_prompt_loses_the_host_the_model_the_provider_and_the_brand():
    scrubbed = core.scrub_prompt(PROMPT)

    for leaked in ("pve", "/home/hermes", "deepseek", "opencode", "Hermes", "Nous", "Provider:", "Model:", "Platform:"):
        assert leaked not in scrubbed, leaked

    assert "Sos el Asistente CloudISP." in scrubbed
    assert "Conversation started: Thursday, October 15, 2026 (America/Argentina/Salta, UTC-03:00)" in scrubbed
    assert "CloudISP delivers their message" in scrubbed
    assert core.scrub_prompt(scrubbed) == scrubbed, "stable, so the provider's prompt cache keeps hitting"


def test_the_request_middleware_scrubs_every_system_prompt_shape():
    request = {
        "model": "m",
        "messages": [
            {"role": "system", "content": PROMPT},
            {"role": "user", "content": "[System note: This is the user's very first message ever. Introduce yourself; /help shows commands.] ¿Qué hacés?"},
            {"role": "assistant", "content": "Hermes dice hola"},
        ],
        "system": [{"type": "text", "text": PROMPT}],
        "instructions": PROMPT,
    }

    result = core.scrub_request(request=request)

    assert result["name"] == "cloudisp-scrub"
    scrubbed = result["request"]
    assert "pve" not in scrubbed["messages"][0]["content"]
    assert scrubbed["messages"][1]["content"] == "¿Qué hacés?"
    assert scrubbed["messages"][2]["content"] == "Hermes dice hola", "only the system prompt and the first-contact note are rewritten"
    assert "pve" not in scrubbed["system"][0]["text"] and "pve" not in scrubbed["instructions"]


def test_a_clean_request_is_left_untouched():
    assert core.scrub_request(request={"messages": [{"role": "system", "content": "Sos el asistente."}, {"role": "user", "content": "hola"}]}) is None
    assert core.scrub_request(request=None) is None


def test_the_chat_strings_hide_the_model_the_provider_and_the_tool_names():
    overrides = core.LOCALE_OVERRIDES

    assert overrides["gateway.reset.header_default"] == "✨ Conversación nueva. Escribí /guia para ver lo que puedo hacer."
    assert all(overrides[key] == "" for key in ("gateway.reset.tip", "gateway.session.info_model", "gateway.session.info_provider", "gateway.session.info_context"))
    assert "{tool}" not in overrides["gateway.progress.tool_preview"] and "{preview}" not in overrides["gateway.progress.tool_preview"]
    assert "{tool}" not in overrides["gateway.progress.tool_pending"]


def test_no_override_names_the_brand_a_tool_or_a_command_the_plugin_blocks():
    for key, text in strings.LOCALE_OVERRIDES.items():
        assert not re.search(r"hermes|nous|deepseek|opencode|openrouter|mcp__|\{tool\}|\{model\}|\{provider\}|\{activity\}|\{url\}|/retry|/login|/model|/stop|/compress|/reset|/busy|/verbose", text, re.IGNORECASE), key
        assert not re.search(r"[A-Za-z]{4,} (the|and|your|you) [a-z]+", text), f"{key} reads as English"


def test_the_heartbeat_has_no_detail_and_the_clarify_card_no_skip_hint():
    assert "{detail}" not in strings.LOCALE_OVERRIDES["gateway.progress.working_heartbeat"]
    assert strings.LOCALE_OVERRIDES["gateway.clarify.skip_hint"] == ""


def test_the_generic_heartbeat_phrases_are_spanish_and_fit_the_runtime_limits():
    for surface in ("status", "generic"):
        phrases = strings.STATUS_PHRASES[surface]

        assert phrases and all(0 < len(phrase) <= 160 and "," not in phrase for phrase in phrases), surface


def test_the_approval_buttons_are_all_spanish():
    for key in ("action_once", "action_session", "action_always", "action_deny"):
        assert re.search(r"Aprobar|Denegar", strings.LOCALE_OVERRIDES[f"gateway.exec_approval.{key}"])


# ─── runtime patches ─────────────────────────────────────────────────────────

RULE_COMMAND = "<mcp__cloudisp__reboot_onu> (plugin approval rule)"


@pytest.mark.parametrize("description, expected", [
    ("✍️ Confirmá: Reiniciar la ONU — Abonado: 2861", ("Reiniciar la ONU", "Abonado: 2861")),
    ("✍️ Confirmá: Cerrar la sesión de conexión (PPPoE)", ("Cerrar la sesión de conexión (PPPoE)", "sin detalles")),
    ("✍️ Confirmá: Cambiar el WiFi — Abonado: 7 · Nombre: Casa — Sur", ("Cambiar el WiFi", "Abonado: 7 · Nombre: Casa — Sur")),
])
def test_the_card_of_a_plugin_write_shows_the_label_and_the_detail(description, expected):
    assert patches.approval_card(RULE_COMMAND, description) == expected


@pytest.mark.parametrize("command, description", [
    ("rm -rf /", "comando peligroso"),
    ("<mcp__other__tool> (plugin approval rule)", "Algo distinto"),
    (RULE_COMMAND, "otra descripción"),
    (RULE_COMMAND, None),
    (None, "✍️ Confirmá: Reiniciar la ONU"),
])
def test_any_other_approval_card_is_left_alone(command, description):
    assert patches.approval_card(command, description) is None


@pytest.fixture
def runtime(monkeypatch):
    """Stand-ins for the two runtime modules the patches touch."""
    import sys
    import types

    clarify = types.ModuleType("tools.clarify_tool")
    clarify.mark_recommended = lambda choices: [f"{choices[0]} (Recommended)", *choices[1:]]
    tools = types.ModuleType("tools")
    tools.clarify_tool = clarify
    calls = []

    class Adapter:
        async def send_exec_approval(self, chat_id, command, session_key, description=None, metadata=None, allow_permanent=True, allow_session=True, smart_denied=False):
            calls.append({"command": command, "description": description, "allow_permanent": allow_permanent, "allow_session": allow_session, "smart_denied": smart_denied})

            return "sent"

    class Telegram(Adapter):
        pass

    base = types.ModuleType("gateway.platforms.base")
    base.BasePlatformAdapter = Adapter
    for name, module in (("tools", tools), ("tools.clarify_tool", clarify), ("gateway", types.ModuleType("gateway")), ("gateway.platforms", types.ModuleType("gateway.platforms")), ("gateway.platforms.base", base)):
        monkeypatch.setitem(sys.modules, name, module)

    return types.SimpleNamespace(clarify=clarify, adapter=Adapter, telegram=Telegram, calls=calls)


def test_the_clarify_card_loses_the_recommended_marker(runtime):
    assert runtime.clarify.mark_recommended(["✅ Confirmar", "❌ Cancelar"])[0].endswith("(Recommended)")

    assert patches.apply()["mark_recommended"] is True
    assert runtime.clarify.mark_recommended(["✅ Confirmar", "❌ Cancelar"]) == ["✅ Confirmar", "❌ Cancelar"]


def test_a_plugin_write_card_offers_only_approve_and_deny(runtime):
    import asyncio

    assert patches.apply()["send_exec_approval"] is True

    result = asyncio.run(runtime.telegram().send_exec_approval(
        chat_id="1", command=RULE_COMMAND, session_key="k", description="✍️ Confirmá: Reiniciar la ONU — Abonado: 2861", metadata=None,
        allow_permanent=True, allow_session=True,
    ))

    assert result == "sent"
    assert runtime.calls == [{"command": "Reiniciar la ONU", "description": "Abonado: 2861", "allow_permanent": False, "allow_session": False, "smart_denied": False}]


def test_every_other_approval_keeps_its_card_and_its_buttons(runtime):
    import asyncio

    patches.apply()
    asyncio.run(runtime.telegram().send_exec_approval("1", "rm -rf /tmp/x", "k", "comando peligroso"))

    assert runtime.calls == [{"command": "rm -rf /tmp/x", "description": "comando peligroso", "allow_permanent": True, "allow_session": True, "smart_denied": False}]


def test_the_patches_apply_once(runtime):
    patches.apply()
    first = (runtime.clarify.mark_recommended, runtime.adapter.send_exec_approval)

    assert patches.apply() == {"mark_recommended": True, "send_exec_approval": True}
    assert (runtime.clarify.mark_recommended, runtime.adapter.send_exec_approval) == first


# ─── patch regressions are loud ──────────────────────────────────────────────


def error_records(caplog):
    return [record.getMessage() for record in caplog.records if record.levelname == "ERROR"]


def test_a_runtime_without_the_targets_logs_each_failed_patch_at_error_with_its_marker(monkeypatch, caplog):
    import sys

    for name in ("tools", "tools.clarify_tool", "gateway", "gateway.platforms", "gateway.platforms.base"):
        monkeypatch.setitem(sys.modules, name, None)

    with caplog.at_level("INFO"):
        assert patches.apply() == {"mark_recommended": False, "send_exec_approval": False}

    messages = error_records(caplog)

    assert len(messages) == 2
    assert messages[0].startswith("CLOUDISP_PATCH_FAILED mark_recommended reason=")
    assert messages[1].startswith("CLOUDISP_PATCH_FAILED send_exec_approval reason=")
    assert all("the runtime's own wording stays" in message for message in messages)


def test_a_moved_clarify_helper_fails_only_that_patch(runtime, caplog):
    runtime.clarify.mark_recommended = "not a function any more"

    with caplog.at_level("INFO"):
        assert patches.apply() == {"mark_recommended": False, "send_exec_approval": True}

    assert error_records(caplog) == [next(message for message in error_records(caplog) if message.startswith("CLOUDISP_PATCH_FAILED mark_recommended "))]
    assert "is not callable" in error_records(caplog)[0]


def test_a_clarify_card_that_still_shows_the_marker_fails_the_patch(runtime, caplog):
    runtime.clarify._normalize_questions = lambda questions: ([{"qid": "q0", "choices": ["✅ Confirmar (Recommended)", "❌ Cancelar"]}], None)

    with caplog.at_level("INFO"):
        assert patches.apply()["mark_recommended"] is False

    assert "clarify cards still carry the marker" in error_records(caplog)[0]


def test_a_clarify_helper_that_cannot_be_probed_does_not_fail_the_patch(runtime):
    runtime.clarify._normalize_questions = lambda questions: (_ for _ in ()).throw(RuntimeError("moved"))

    assert patches.apply()["mark_recommended"] is True


@pytest.mark.parametrize("drift, reason", [
    (lambda self, chat_id, text: None, "is no longer a coroutine function"),
    (None, "no longer takes command, session_key, description, metadata, allow_permanent, allow_session, smart_denied"),
])
def test_a_changed_approval_signature_fails_the_patch_and_leaves_the_runtime_method_alone(runtime, caplog, drift, reason):
    async def renamed(self, chat_id, text):
        return "sent"

    original = drift or renamed
    runtime.adapter.send_exec_approval = original

    with caplog.at_level("INFO"):
        assert patches.apply() == {"mark_recommended": True, "send_exec_approval": False}

    assert runtime.adapter.send_exec_approval is original
    assert reason in error_records(caplog)[0]
    assert error_records(caplog)[0].startswith("CLOUDISP_PATCH_FAILED send_exec_approval reason=PatchError")


def test_a_telegram_adapter_that_overrides_the_approval_method_fails_the_patch(runtime, caplog):
    class TelegramAdapter(runtime.adapter):
        async def send_exec_approval(self, chat_id, command, session_key, description=None, metadata=None, allow_permanent=True, allow_session=True, smart_denied=False):
            return "own card"

    with caplog.at_level("INFO"):
        assert patches.apply()["send_exec_approval"] is False

    assert "overrides send_exec_approval and bypasses the wrapper" in error_records(caplog)[0]
    assert TelegramAdapter.__qualname__ in error_records(caplog)[0]


def test_the_ready_line_lists_the_failed_patches():
    ok = {"mark_recommended": True, "send_exec_approval": True}

    assert patches.ready_line(ok) == "CLOUDISP_PLUGIN_READY patches=ok"
    assert patches.ready_line(ok, version="0.5.0", write_tools=19) == "CLOUDISP_PLUGIN_READY patches=ok version=0.5.0 write_tools=19"
    assert patches.ready_line({"mark_recommended": True, "send_exec_approval": False}) == "CLOUDISP_PLUGIN_READY patches=failed:send_exec_approval"
    assert patches.ready_line({"mark_recommended": False, "send_exec_approval": False}, profile="p") == "CLOUDISP_PLUGIN_READY patches=failed:mark_recommended,send_exec_approval profile=p"


def test_the_loggers_inherit_the_runtime_namespace_that_reaches_gateway_log():
    # The runtime loads the plugin as `hermes_plugins.cloudisp`; only `hermes_plugins*` loggers reach gateway.log.
    import cloudisp

    assert core.log.name == core.__name__ and patches.log.name == patches.__name__ and cloudisp.log.name == cloudisp.__name__


def test_the_plugin_version_is_the_one_of_the_manifest_and_of_the_package():
    package = json.loads((PLUGIN_DIR.parents[1] / "package.json").read_text())

    assert core.VERSION == package["version"]
    assert f'version: "{core.VERSION}"' in (PLUGIN_DIR / "plugin.yaml").read_text()


# ─── wiring ──────────────────────────────────────────────────────────────────


class FakeContext:
    profile_name = "cloudisp-nvs"

    def __init__(self):
        self.hooks, self.commands, self.middleware, self.locales = [], {}, [], {}

    def register_hook(self, name, callback):
        self.hooks.append((name, callback.__name__))

    def register_command(self, name, handler, description="", **_):
        self.commands[name] = handler

    def register_middleware(self, kind, callback):
        self.middleware.append((kind, callback.__name__))

    def register_locale(self, language, source, **_):
        self.locales[language] = source


def test_register_wires_every_hook_command_middleware_and_locale(env):
    ctx = FakeContext()

    register(ctx)

    assert sorted(ctx.hooks) == sorted([
        ("pre_gateway_dispatch", "pre_gateway_dispatch"),
        ("pre_tool_call", "pre_tool_call_identity"),
        ("pre_tool_call", "pre_tool_call_gate"),
        ("subagent_start", "on_subagent_start"),
        ("post_approval_response", "on_approval_response"),
        ("post_api_request", "on_usage"),
        ("post_auxiliary_call", "on_usage"),
        ("transform_llm_output", "transform_llm_output"),
    ])
    assert sorted(ctx.commands) == ["cloudisp-blocked", "cloudisp-quota", "guia"]
    assert ctx.middleware == [("llm_request", "scrub_request")]
    assert sorted(ctx.locales) == ["en", "es"]
    assert "reboot_onu" in core.WRITE_TOOLS


def lines(caplog, marker):
    return [(record.levelname, record.getMessage()) for record in caplog.records if marker in record.getMessage()]


def test_register_logs_one_healthy_ready_line_when_every_patch_applies(env, runtime, caplog):
    with caplog.at_level("INFO"):
        register(FakeContext())

    assert lines(caplog, "CLOUDISP_PLUGIN_READY") == [(
        "INFO", f"CLOUDISP_PLUGIN_READY patches=ok version={core.VERSION} write_tools={len(core.WRITE_TOOLS)} middleware=ok locale=ok profile=cloudisp-nvs",
    )]
    assert lines(caplog, "CLOUDISP_PATCH_FAILED") == []


def test_register_logs_the_failed_patches_at_error_and_still_wires_the_plugin(env, monkeypatch, caplog):
    import sys

    for name in ("tools", "tools.clarify_tool", "gateway", "gateway.platforms", "gateway.platforms.base"):
        monkeypatch.setitem(sys.modules, name, None)

    ctx = FakeContext()

    with caplog.at_level("INFO"):
        register(ctx)

    failed = lines(caplog, "CLOUDISP_PATCH_FAILED")

    assert [level for level, _ in failed] == ["ERROR", "ERROR"]
    assert [message.split()[1] for _, message in failed] == ["mark_recommended", "send_exec_approval"]
    assert lines(caplog, "CLOUDISP_PLUGIN_READY") == [(
        "ERROR", f"CLOUDISP_PLUGIN_READY patches=failed:mark_recommended,send_exec_approval version={core.VERSION} write_tools={len(core.WRITE_TOOLS)} middleware=ok locale=ok profile=cloudisp-nvs",
    )]
    assert ("pre_tool_call", "pre_tool_call_gate") in ctx.hooks and sorted(ctx.locales) == ["en", "es"]


def test_register_flags_a_missing_middleware_or_locale_on_the_ready_line(env, runtime, caplog):
    ctx = FakeContext()
    ctx.register_middleware = lambda *args: (_ for _ in ()).throw(AttributeError("no middleware"))
    ctx.register_locale = lambda *args, **kw: (_ for _ in ()).throw(AttributeError("no locales"))

    with caplog.at_level("INFO"):
        register(ctx)

    assert lines(caplog, "CLOUDISP_PLUGIN_READY") == [(
        "WARNING", f"CLOUDISP_PLUGIN_READY patches=ok version={core.VERSION} write_tools={len(core.WRITE_TOOLS)} middleware=failed locale=failed profile=cloudisp-nvs",
    )]


def test_register_fails_without_the_write_list(env, monkeypatch):
    monkeypatch.setattr(core, "load_write_tools", lambda: (_ for _ in ()).throw(FileNotFoundError("write_tools.json")))

    with pytest.raises(FileNotFoundError):
        register(FakeContext())


def test_register_survives_a_runtime_without_middleware_or_locales(env):
    ctx = FakeContext()
    ctx.register_middleware = lambda *args: (_ for _ in ()).throw(AttributeError("no middleware"))
    ctx.register_locale = lambda *args, **kw: (_ for _ in ()).throw(AttributeError("no locales"))

    register(ctx)

    assert ctx.hooks


def test_the_manifest_names_the_plugin_and_the_hooks_it_registers():
    manifest = (PLUGIN_DIR / "plugin.yaml").read_text()

    assert "name: cloudisp" in manifest and 'requires_hermes: ">=0.22"' in manifest
    assert all(f"- {hook}" in manifest for hook in ("pre_gateway_dispatch", "pre_tool_call", "post_api_request", "transform_llm_output"))


# ─── deploy scripts ──────────────────────────────────────────────────────────

DEPLOY_DIR = Path(__file__).resolve().parents[3] / "deploy" / "hermes-tenant"


@pytest.mark.parametrize("script", ["new-tenant.sh", "host-setup.sh"])
def test_the_deploy_scripts_configure_the_spanish_heartbeat_and_the_seen_tips(script):
    text = (DEPLOY_DIR / script).read_text()
    expected = {surface: "[" + ", ".join(phrases) + "]" for surface, phrases in strings.STATUS_PHRASES.items()}

    assert f"cfg display.status_phrases.status '{expected['status']}'" in text
    assert f"cfg display.status_phrases.generic '{expected['generic']}'" in text
    assert "cfg display.status_phrases.mode replace" in text
    assert "cfg onboarding.seen.busy_input_prompt true" in text
    assert "cfg onboarding.seen.tool_progress_prompt true" in text
    assert "cfg approvals.destructive_slash_confirm false" in text
    assert "cfg display.platforms.telegram.long_running_notifications generic" in text
