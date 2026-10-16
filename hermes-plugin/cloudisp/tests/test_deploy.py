"""`deploy/hermes-tenant/new-tenant.sh` and `host-setup.sh`, run for real with stub `hermes` and `op` binaries.

The stub `hermes` logs every call and creates a profile where the real one does: under the Hermes root, which is
`HERMES_HOME` (or the root of the profile `HERMES_HOME` points at). The scripts must agree with it.
"""

import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
DEPLOY = REPO / "deploy" / "hermes-tenant"

pytestmark = pytest.mark.skipif(shutil.which("bash") is None or shutil.which("node") is None, reason="needs bash and node")

STUB_HERMES = """#!/usr/bin/env bash
echo "$*" >> "$STUB_CALLS"
root="${HERMES_HOME:?}"
[ "$(basename "$(dirname "$root")")" = profiles ] && root="$(dirname "$(dirname "$root")")"
if [ "$1" = profile ] && [ "$2" = create ]; then
    mkdir -p "$root/profiles/$3"
    : > "$root/profiles/$3/.env"
fi
"""

STUB_OP = """#!/usr/bin/env bash
case "$2" in
    *token*) echo "0000000000:FAKE-TELEGRAM-TOKEN";;
    *) echo "fake-cloudisp-api-key";;
esac
"""


@pytest.fixture
def sandbox(tmp_path):
    """HOME, a Hermes root elsewhere, a source profile with a fake model key, stub binaries."""
    home = tmp_path / "home"
    root = tmp_path / "hermes-root"
    bin_dir = tmp_path / "bin"

    for directory in (home, root / "profiles" / "cloudisp-src", bin_dir):
        directory.mkdir(parents=True)

    (root / "profiles" / "cloudisp-src" / ".env").write_text("OPENCODE_GO_API_KEY=FAKE-MODEL-KEY\n")

    for name, body in (("hermes", STUB_HERMES), ("op", STUB_OP)):
        path = bin_dir / name
        path.write_text(body)
        path.chmod(path.stat().st_mode | stat.S_IEXEC)

    calls = tmp_path / "calls.log"
    env = {
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "HOME": str(home),
        "HERMES_HOME": str(root),
        "STUB_CALLS": str(calls),
        "CLOUDISP_MCP_HOME": str(REPO),
        "CLOUDISP_MCP_CONFIG_DIR": str(tmp_path / "cfg"),
        "CLOUDISP_API_BASE": "https://sandbox.invalid",
        "SOURCE_PROFILE": "cloudisp-src",
    }

    return {"home": home, "root": root, "env": env, "calls": calls, "tmp": tmp_path}


def run(script, args, sandbox, **extra_env):
    return subprocess.run(
        ["bash", str(DEPLOY / script), *args], env={**sandbox["env"], **extra_env}, capture_output=True, text=True, timeout=120, check=False,
    )


def calls(sandbox):
    return sandbox["calls"].read_text().splitlines() if sandbox["calls"].exists() else []


def test_new_tenant_follows_hermes_home_not_home(sandbox):
    result = run("new-tenant.sh", ["acme", "Acme S.A.", "op://V/token/c", "op://V/key/c", "123456789"], sandbox)

    assert result.returncode == 0, result.stderr
    profile = sandbox["root"] / "profiles" / "cloudisp-acme"
    assert (profile / "SOUL.md").is_file() and (profile / ".env").is_file()
    assert (profile / "plugins" / "cloudisp").is_symlink()
    assert not (sandbox["home"] / ".hermes").exists(), "nothing is written under $HOME/.hermes when HERMES_HOME points elsewhere"


def test_new_tenant_maps_a_profile_home_back_to_the_hermes_root(sandbox):
    other = sandbox["root"] / "profiles" / "cloudisp-other"
    other.mkdir()
    result = run("new-tenant.sh", ["acme", "Acme", "op://V/token/c", "op://V/key/c", "123456789"], sandbox, HERMES_HOME=str(other))

    assert result.returncode == 0, result.stderr
    assert (sandbox["root"] / "profiles" / "cloudisp-acme" / "SOUL.md").is_file()
    assert not (other / "profiles").exists()


def test_new_tenant_writes_secrets_only_to_600_files_and_never_prints_them(sandbox):
    result = run("new-tenant.sh", ["acme", "Acme", "op://V/token/c", "op://V/key/c", "123456789"], sandbox)
    profile_env = sandbox["root"] / "profiles" / "cloudisp-acme" / ".env"
    mcp_env = sandbox["tmp"] / "cfg" / "acme.env"

    assert result.returncode == 0, result.stderr
    assert stat.S_IMODE(profile_env.stat().st_mode) == 0o600 and stat.S_IMODE(mcp_env.stat().st_mode) == 0o600
    assert "OPENCODE_GO_API_KEY=FAKE-MODEL-KEY" in profile_env.read_text() and "TELEGRAM_HOME_CHANNEL=123456789" in profile_env.read_text()
    assert "CLOUDISP_REQUIRE_OPERATOR=1" in mcp_env.read_text() and "CLOUDISP_API_BASE=https://sandbox.invalid" in mcp_env.read_text()

    for secret in ("FAKE-TELEGRAM-TOKEN", "fake-cloudisp-api-key", "FAKE-MODEL-KEY"):
        assert secret not in result.stdout + result.stderr
        assert not any(secret in call for call in calls(sandbox)), "a secret never travels in argv"


def test_new_tenant_configures_everything_through_hermes_config_set_on_its_own_profile(sandbox):
    run("new-tenant.sh", ["acme", "Acme", "op://V/token/c", "op://V/key/c", "123456789"], sandbox)

    configured = [call for call in calls(sandbox) if " config set " in f" {call} "]

    assert calls(sandbox)[0].startswith("profile create cloudisp-acme --no-skills")
    assert len(configured) == 33 and all(call.startswith("-p cloudisp-acme config set ") for call in configured)
    assert "-p cloudisp-acme config set plugins.enabled [cloudisp]" in configured
    assert "-p cloudisp-acme config set mcp_servers.cloudisp.args ['acme']" in configured


def test_new_tenant_renders_the_soul_without_the_runtime_brand_or_placeholders(sandbox):
    run("new-tenant.sh", ["acme", "Acme S.A.", "op://V/token/c", "op://V/key/c"], sandbox)
    soul = (sandbox["root"] / "profiles" / "cloudisp-acme" / "SOUL.md").read_text()

    assert soul.startswith("# Asistente CloudISP · Acme S.A.")
    assert not re.search(r"hermes|nous|omh|opencode|deepseek|\{BOT_NAME\}|\{TENANT_NAME\}", soul, re.IGNORECASE)


def test_new_tenant_numbers_the_manual_steps_without_gaps(sandbox):
    with_id = run("new-tenant.sh", ["acme", "Acme", "op://V/token/c", "op://V/key/c", "123456789"], sandbox).stdout
    without_id = run("new-tenant.sh", ["beta", "Beta", "op://V/token/c", "op://V/key/c"], sandbox).stdout

    assert re.findall(r"^  (\d)\. ", with_id, re.MULTILINE) == ["1", "2", "3", "4"]
    assert re.findall(r"^  (\d)\. ", without_id, re.MULTILINE) == ["1", "2", "3", "4", "5"]
    assert "TELEGRAM_ALLOWED_USERS" in without_id and "TELEGRAM_ALLOWED_USERS" not in with_id


@pytest.mark.parametrize("args, message", [
    (["Bad_Slug", "X", "op://V/token/c", "op://V/key/c"], "slug inválido"),
    (["acme", "X", "plain-token", "op://V/key/c"], "referencias op://"),
    (["acme", "X", "op://V/token/c", "op://V/key/c", "abc"], "numérico"),
    (["acme", "", "op://V/token/c", "op://V/key/c"], "no puede estar vacío"),
])
def test_new_tenant_refuses_bad_arguments_before_touching_anything(sandbox, args, message):
    result = run("new-tenant.sh", args, sandbox)

    assert result.returncode != 0 and message in result.stderr
    assert calls(sandbox) == [] and not (sandbox["tmp"] / "cfg").exists()


def test_new_tenant_refuses_an_existing_profile_and_a_source_without_the_model_key(sandbox):
    (sandbox["root"] / "profiles" / "cloudisp-acme").mkdir()

    assert "ya existe" in run("new-tenant.sh", ["acme", "X", "op://V/token/c", "op://V/key/c"], sandbox).stderr
    assert "no encuentro OPENCODE_GO_API_KEY" in run("new-tenant.sh", ["beta", "X", "op://V/token/c", "op://V/key/c"], sandbox, SOURCE_PROFILE="nope").stderr
    assert calls(sandbox) == []


def test_new_tenant_stops_with_its_own_message_when_op_fails_and_creates_nothing(sandbox):
    failing = sandbox["tmp"] / "bin" / "op"
    failing.write_text('#!/usr/bin/env bash\necho "not signed in" >&2\nexit 1\n')
    result = run("new-tenant.sh", ["acme", "X", "op://V/token/c", "op://V/key/c"], sandbox)

    assert result.returncode != 0 and "op read del token del bot falló" in result.stderr
    assert calls(sandbox) == [] and not (sandbox["root"] / "profiles" / "cloudisp-acme").exists()


def test_host_setup_configures_the_host_with_dash_p_default_and_links_the_plugin_under_hermes_home(sandbox):
    result = run("host-setup.sh", [], sandbox)

    assert result.returncode == 0, result.stderr
    configured = calls(sandbox)

    assert len(configured) == 18 and all(call.startswith("-p default config set ") for call in configured)
    assert "-p default config set plugins.enabled [omh, cloudisp]" in configured
    assert (sandbox["root"] / "plugins" / "cloudisp").is_symlink()
    assert not (sandbox["home"] / ".hermes").exists()
    assert (sandbox["home"] / ".cache" / "cloudisp-artifacts").is_dir()


def test_host_setup_is_idempotent_and_refuses_a_bot_token_in_the_host_env(sandbox):
    assert run("host-setup.sh", [], sandbox).returncode == 0
    assert run("host-setup.sh", [], sandbox).returncode == 0
    assert (sandbox["root"] / "plugins" / "cloudisp").is_symlink()

    (sandbox["root"] / ".env").write_text("TELEGRAM_BOT_TOKEN=FAKE\n")
    refused = run("host-setup.sh", [], sandbox)

    assert refused.returncode != 0 and "TELEGRAM_BOT_TOKEN" in refused.stderr and "FAKE" not in refused.stderr
