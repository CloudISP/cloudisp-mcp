"""Fixtures: the plugin imported as a package, with the runtime's session variables, config and HTTP stubbed."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from cloudisp import core  # noqa: E402


class Event:
    """The part of the runtime's MessageEvent the plugin reads."""

    def __init__(self, text, profile="cloudisp-nvs"):
        self.text = text
        self.source = type("Source", (), {"profile": profile})()

    def get_command(self):
        if not self.text.startswith("/"):
            return None

        raw = self.text.split(maxsplit=1)[0][1:].lower().split("@", 1)[0]

        return None if "/" in raw else raw


class Session:
    """Task-local session variables of the runtime (`get_session_env`)."""

    def __init__(self):
        self.values = {
            "HERMES_SESSION_USER_ID": "941533777",
            "HERMES_SESSION_USER_NAME": "Mario Santos",
            "HERMES_SESSION_PLATFORM": "telegram",
            "HERMES_SESSION_KEY": "agent:main:telegram:dm:941533777",
            "HERMES_SESSION_PROFILE": "cloudisp-nvs",
        }

    def __call__(self, name, default=""):
        return self.values.get(name, default)


@pytest.fixture
def session(monkeypatch):
    stub = Session()
    monkeypatch.setattr(core, "get_session_env", stub)

    return stub


@pytest.fixture
def env(tmp_path, monkeypatch, session):
    """A profile config with credentials, an empty cache directory and the module state reset."""
    cache = tmp_path / "cache"
    env_file = tmp_path / "prod.env"
    env_file.write_text("CLOUDISP_API_BASE=https://admin.example.test\nCLOUDISP_API_KEY=secret-key\n")
    config = tmp_path / "config.yaml"
    config.write_text(
        "plugins:\n  entries:\n    cloudisp:\n      settings:\n"
        f"        env_file: {env_file}\n        tenant_name: NVS InterService\n        bot_name: Asistente CloudISP\n"
    )
    monkeypatch.setenv(core.CACHE_DIR_ENV, str(cache))
    monkeypatch.setattr(core, "_config_path", lambda profile: config)
    monkeypatch.setattr(core, "WRITE_TOOLS", {"reboot_onu": "Reiniciar la ONU", "kick_pppoe": "Cerrar la sesión de conexión (PPPoE)"})
    core._settings_cache.clear()
    core._quota_cache.clear()
    core._child_sessions.clear()
    core._denied_turns.clear()

    return tmp_path
