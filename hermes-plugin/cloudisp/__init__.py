"""Hermes plugin `cloudisp`: the commercial layer of the CloudISP assistant. See README.md."""

from __future__ import annotations

import logging

from . import core

log = logging.getLogger("cloudisp")


def register(ctx) -> None:
    """Wire the plugin. The hooks and the write list are required (without them there is no identity
    and no approval, and the MCP refuses every write); the rest degrades with a warning."""
    core.WRITE_TOOLS.clear()
    core.WRITE_TOOLS.update(core.load_write_tools())

    ctx.register_hook("pre_gateway_dispatch", core.pre_gateway_dispatch)
    # Two callbacks: one directive per callback, and a write needs both `modify` and `approve`.
    ctx.register_hook("pre_tool_call", core.pre_tool_call_identity)
    ctx.register_hook("pre_tool_call", core.pre_tool_call_gate)
    ctx.register_hook("subagent_start", core.on_subagent_start)
    ctx.register_hook("post_api_request", core.on_usage)
    ctx.register_hook("post_auxiliary_call", core.on_usage)
    ctx.register_hook("transform_llm_output", core.transform_llm_output)

    ctx.register_command("guia", core.guia_command, description="Guía de lo que puedo hacer")
    ctx.register_command(core.BLOCKED_COMMAND, core.blocked_command, description="Comando no disponible")
    ctx.register_command(core.QUOTA_COMMAND, core.quota_command, description="Cupo de uso agotado")

    try:
        ctx.register_middleware("llm_request", core.scrub_request)
    except Exception as error:
        log.warning("cloudisp: prompt scrubbing is off (no llm_request middleware): %s", error)

    for language in ("es", "en"):
        try:
            ctx.register_locale(language, core.LOCALE_OVERRIDES)
        except Exception as error:
            log.warning("cloudisp: chat strings not overridden for %s: %s", language, error)
