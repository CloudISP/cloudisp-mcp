"""Two small in-process patches of the runtime, for what neither a hook nor a locale string can change.

Both are applied once from `register` (idempotent, guarded): if the runtime moves the target, the plugin logs a
warning and keeps working, only with the runtime's own wording.

* **Clarify card.** The runtime appends the hard-coded English `(Recommended)` to the first choice
  (`tools.clarify_tool.mark_recommended`). The marker is dropped: the SOUL already orders the options.
* **Approval card of a write.** The runtime shows `<mcp__server__tool> (plugin approval rule)` (an internal tool name)
  in a code box and offers "session" and "always" buttons. For the plugin's own approvals the card shows the Spanish
  action label and its detail, with only Aprobar and Denegar. Every other approval is left untouched.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from .strings import APPROVAL_NO_DETAIL

log = logging.getLogger("cloudisp")

# Exactly what `tools.approval.request_tool_approval` puts in the code box, and what `core.pre_tool_call_gate` sends.
_RULE_COMMAND = re.compile(r"^<mcp__[A-Za-z0-9_]+> \(plugin approval rule\)$")
_CONFIRM = re.compile(r"^✍️ Confirmá: (?P<label>.+?)(?: — (?P<detail>.*))?$", re.DOTALL)


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


def patch_clarify() -> bool:
    """Drop the `(Recommended)` marker the runtime adds to the first choice of a clarify card."""
    from tools import clarify_tool

    original = clarify_tool.mark_recommended

    if getattr(original, "_cloudisp_patched", False):
        return True

    def mark_recommended(choices: list[str]) -> list[str]:
        return choices

    mark_recommended._cloudisp_patched = True  # type: ignore[attr-defined]
    clarify_tool.mark_recommended = mark_recommended

    return True


def patch_exec_approval() -> bool:
    """Rewrite the card of the plugin's write approvals (see the module docstring)."""
    from gateway.platforms.base import BasePlatformAdapter

    original = BasePlatformAdapter.send_exec_approval

    if getattr(original, "_cloudisp_patched", False):
        return True

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

    return True


def apply() -> dict[str, bool]:
    """Apply every patch; a patch that cannot be applied is logged and reported as False."""
    applied = {}

    for name, patch in (("clarify", patch_clarify), ("exec_approval", patch_exec_approval)):
        try:
            applied[name] = patch()
        except Exception as error:
            applied[name] = False
            log.warning("cloudisp: runtime patch %r not applied (%s: %s); the runtime's own wording stays", name, type(error).__name__, error)

    return applied
