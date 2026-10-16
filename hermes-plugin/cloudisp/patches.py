"""Two small in-process patches of the runtime, for what neither a hook nor a locale string can change.

Both are applied once from `register` (idempotent, guarded). A patch that cannot be applied is never silent:
`apply()` logs `CLOUDISP_PATCH_FAILED <name> ...` at ERROR, the runtime keeps its own wording, and `register`
adds the `CLOUDISP_PLUGIN_READY patches=...` health line (see `ready_line`).

* **mark_recommended.** The runtime appends the hard-coded English `(Recommended)` to the first choice of a
  clarify card (`tools.clarify_tool.mark_recommended`). The marker is dropped: the SOUL already orders the options.
* **send_exec_approval.** The runtime shows `<mcp__server__tool> (plugin approval rule)` (an internal tool name)
  in a code box and offers "session" and "always" buttons. For the plugin's own approvals the card shows the
  Spanish action label and its detail, with only Aprobar and Denegar. Every other approval is left untouched.
"""

from __future__ import annotations

import inspect
import logging
import re
from typing import Any

from .strings import APPROVAL_NO_DETAIL

# Under the runtime this is `hermes_plugins.cloudisp.patches`: only `hermes_plugins*` loggers reach gateway.log.
log = logging.getLogger(__name__)

PATCH_FAILED_MARKER = "CLOUDISP_PATCH_FAILED"
READY_MARKER = "CLOUDISP_PLUGIN_READY"

MARK_RECOMMENDED = "mark_recommended"
SEND_EXEC_APPROVAL = "send_exec_approval"

# Exactly what `tools.approval.request_tool_approval` puts in the code box, and what `core.gate_write` sends.
_RULE_COMMAND = re.compile(r"^<mcp__[A-Za-z0-9_]+> \(plugin approval rule\)$")
_CONFIRM = re.compile(r"^✍️ Confirmá: (?P<label>.+?)(?: — (?P<detail>.*))?$", re.DOTALL)

# What the wrapper passes to the runtime's `send_exec_approval`: the signature must still take all of it.
_EXEC_APPROVAL_PARAMS = ("chat_id", "command", "session_key", "description", "metadata", "allow_permanent", "allow_session", "smart_denied")


class PatchError(Exception):
    """A patch whose target moved or whose effect could not be confirmed."""


def approval_card(command: str, description: str | None) -> tuple[str, str] | None:
    """`(code box, detail)` of the card of a plugin write, or None when the approval is not one of ours."""
    if not isinstance(command, str) or not isinstance(description, str):
        return None

    if not _RULE_COMMAND.match(command.strip()):
        return None

    match = _CONFIRM.match(description.strip())

    if match is None:
        return None

    return match.group("label").strip(), (match.group("detail") or "").strip() or APPROVAL_NO_DETAIL


def _clarify_choices_shown(clarify_tool: Any) -> list[str] | None:
    """The choices a two-option clarify card would render, or None when the runtime's private helper moved."""
    normalize = getattr(clarify_tool, "_normalize_questions", None)

    if not callable(normalize):
        return None

    try:
        result = normalize([{"question": "q", "choices": ["a", "b"]}])
        questions = result[0] if isinstance(result, tuple) else result

        return [str(choice) for choice in questions[0]["choices"]]
    except Exception:
        return None


def patch_mark_recommended() -> None:
    """Drop the `(Recommended)` marker the runtime adds to the first choice of a clarify card."""
    from tools import clarify_tool

    original = clarify_tool.mark_recommended

    if not getattr(original, "_cloudisp_patched", False):
        if not callable(original):
            raise PatchError("tools.clarify_tool.mark_recommended is not callable")

        def mark_recommended(choices: list[str]) -> list[str]:
            return choices

        mark_recommended._cloudisp_patched = True  # type: ignore[attr-defined]
        clarify_tool.mark_recommended = mark_recommended

    if clarify_tool.mark_recommended(["a", "b"]) != ["a", "b"]:
        raise PatchError("the replacement did not take effect on tools.clarify_tool")

    shown = _clarify_choices_shown(clarify_tool)

    if shown is not None and any("recommended" in choice.lower() for choice in shown):
        raise PatchError(f"clarify cards still carry the marker: {shown}")


def _subclasses(cls: type) -> list[type]:
    found: list[type] = []

    for sub in cls.__subclasses__():
        found.append(sub)
        found.extend(_subclasses(sub))

    return found


def patch_send_exec_approval() -> None:
    """Rewrite the card of the plugin's write approvals (see the module docstring)."""
    from gateway.platforms.base import BasePlatformAdapter

    original = BasePlatformAdapter.send_exec_approval

    if not getattr(original, "_cloudisp_patched", False):
        if not inspect.iscoroutinefunction(original):
            raise PatchError("BasePlatformAdapter.send_exec_approval is no longer a coroutine function")

        missing = [name for name in _EXEC_APPROVAL_PARAMS if name not in inspect.signature(original).parameters]

        if missing:
            raise PatchError(f"BasePlatformAdapter.send_exec_approval no longer takes {', '.join(missing)}")

        async def send_exec_approval(
            self: Any, chat_id: str, command: str, session_key: str, description: str | None = None, metadata: dict | None = None,
            allow_permanent: bool = True, allow_session: bool = True, smart_denied: bool = False,
        ) -> Any:
            try:
                card = approval_card(command, description)
            except Exception:  # never let a formatting problem stop the confirmation itself
                card = None

            if card is not None:
                command, description = card
                allow_permanent = allow_session = False

            return await original(
                self, chat_id, command, session_key, description=description, metadata=metadata,
                allow_permanent=allow_permanent, allow_session=allow_session, smart_denied=smart_denied,
            )

        send_exec_approval._cloudisp_patched = True  # type: ignore[attr-defined]
        BasePlatformAdapter.send_exec_approval = send_exec_approval

    if not getattr(BasePlatformAdapter.send_exec_approval, "_cloudisp_patched", False):
        raise PatchError("the wrapper did not take effect on BasePlatformAdapter")

    # An adapter that overrides the method itself would bypass the wrapper (only checks the adapters already imported).
    bypassing = [f"{cls.__module__}.{cls.__qualname__}" for cls in _subclasses(BasePlatformAdapter) if "telegram" in f"{cls.__module__}.{cls.__name__}".lower() and "send_exec_approval" in vars(cls)]

    if bypassing:
        raise PatchError(f"a Telegram adapter overrides send_exec_approval and bypasses the wrapper: {', '.join(bypassing)}")


def apply() -> dict[str, bool]:
    """Apply every patch; a patch that cannot be applied is logged at ERROR with its marker and reported as False."""
    results: dict[str, bool] = {}

    for name, patch in ((MARK_RECOMMENDED, patch_mark_recommended), (SEND_EXEC_APPROVAL, patch_send_exec_approval)):
        try:
            patch()
            results[name] = True
        except Exception as error:
            results[name] = False
            log.error("%s %s reason=%s: %s; the runtime's own wording stays", PATCH_FAILED_MARKER, name, type(error).__name__, error)

    return results


def ready_line(results: dict[str, bool], **fields: Any) -> str:
    """`CLOUDISP_PLUGIN_READY patches=ok ...` or `... patches=failed:<names> ...`: the health line `register` logs at startup."""
    failed = [name for name, ok in results.items() if not ok]
    status = "ok" if not failed else "failed:" + ",".join(failed)

    return " ".join([f"{READY_MARKER} patches={status}", *(f"{key}={value}" for key, value in fields.items())])
