"""Behaviour of the `cloudisp` plugin, with the runtime stubbed (see conftest.py)."""

import json
import re
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
        "conversation": "agent:main:telegram:dm:941533777", "profile": "cloudisp-nvs",
    }}}


def test_a_session_without_user_overwrites_any_operator_with_null(env, session):
    session.values.pop("HERMES_SESSION_USER_ID")

    assert core.pre_tool_call_identity("mcp__cloudisp__reboot_onu", {"_operator": {"id": "1", "channel": "telegram"}}, "s") == {
        "action": "modify", "args": {"_operator": None},
    }


def test_the_conversation_falls_back_to_the_session_id_and_the_channel_to_cli(env, session):
    session.values.pop("HERMES_SESSION_KEY")
    session.values.pop("HERMES_SESSION_PLATFORM")

    operator = core.pre_tool_call_identity("mcp__cloudisp__find_subscriber", {}, "sess-9")["args"]["_operator"]

    assert (operator["conversation"], operator["channel"]) == ("sess-9", "cli")


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
        "conversation_ref": "agent:main:telegram:dm:941533777", "operator_ref": "telegram:941533777", "operator_name": "Mario Santos",
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

    assert patches.apply()["clarify"] is True
    assert runtime.clarify.mark_recommended(["✅ Confirmar", "❌ Cancelar"]) == ["✅ Confirmar", "❌ Cancelar"]


def test_a_plugin_write_card_offers_only_approve_and_deny(runtime):
    import asyncio

    assert patches.apply()["exec_approval"] is True

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
    patches.apply()

    assert (runtime.clarify.mark_recommended, runtime.adapter.send_exec_approval) == first


def test_a_runtime_without_the_targets_only_logs(monkeypatch, caplog):
    import sys

    for name in ("tools", "tools.clarify_tool", "gateway", "gateway.platforms", "gateway.platforms.base"):
        monkeypatch.setitem(sys.modules, name, None)

    with caplog.at_level("WARNING", logger="cloudisp"):
        assert patches.apply() == {"clarify": False, "exec_approval": False}

    assert "runtime patch 'clarify' not applied" in caplog.text


# ─── wiring ──────────────────────────────────────────────────────────────────


class FakeContext:
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
