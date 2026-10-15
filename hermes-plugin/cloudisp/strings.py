"""Everything the plugin (or the runtime, rewritten by the plugin) says to the operator, in Spanish.

`LOCALE_OVERRIDES` is registered as a language pack for `es` and `en`: the runtime's own chat strings
(session banner, heartbeat, approval card, errors, restart notices) lose the model, the provider, the
brand, raw tool names and the commands the plugin blocks. Keys are the runtime's catalog keys
(`locales/es.yaml`); every `{placeholder}` kept here exists in the original string.
"""

from __future__ import annotations

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
DENIED_RETRY_TEXT = (
    "El operador no confirmó la acción anterior y no se ejecutó. No la reintentes en este turno: "
    "sólo un mensaje nuevo del operador puede volver a pedirla."
)
NEUTRAL_RESET_TEXT = "✨ Conversación nueva. Escribí /guia para ver lo que puedo hacer."
TRY_AGAIN_TEXT = "⚠️ No pude completar la respuesta en este momento. Probá de nuevo en unos minutos o escribí /new para empezar una conversación nueva."

# Shown in the approval card instead of the runtime's "<mcp__server__tool> (plugin approval rule)".
APPROVAL_NO_DETAIL = "sin detalles"

LOCALE_OVERRIDES: dict[str, str] = {
    # /new and the session banner: no model, provider, context size or tip.
    "gateway.reset.header_default": NEUTRAL_RESET_TEXT,
    "gateway.reset.header_new": NEUTRAL_RESET_TEXT,
    "gateway.reset.header_titled": NEUTRAL_RESET_TEXT,
    "gateway.reset.tip": "",
    "gateway.session.info_model": "",
    "gateway.session.info_provider": "",
    "gateway.session.info_context": "",
    "gateway.session.info_acting_model": "",
    "gateway.session.info_endpoint": "",
    "gateway.session.auto_reset_notice": "◐ La conversación se reinició por inactividad. Escribí /guia para ver lo que puedo hacer.",
    "gateway.notify.no_home_channel": "",
    "gateway.unknown_command": BLOCKED_TEXT,
    # Progress and heartbeat: no tool names, no English activity descriptions.
    "gateway.progress.tool_preview": "{emoji} Consultando CloudISP…",
    "gateway.progress.tool_pending": "{emoji} Consultando CloudISP…",
    "gateway.progress.tool_head": "{emoji} Consultando CloudISP…",
    "gateway.progress.tool_verbose": "{emoji} Consultando CloudISP…",
    "gateway.progress.working_heartbeat": "⏳ Trabajando — {minutes} min",
    "gateway.progress.task_card_title": "El asistente está trabajando",
    "gateway.progress.stuck_warning": (
        "⚠️ Parece que estoy atascado (sin actividad desde hace {minutes} min). Si no ocurre nada en los próximos "
        "{remaining} min, abandonaré esta tarea. Podés seguir esperando o escribir /new para empezar una conversación nueva."
    ),
    "gateway.progress.timeout_header": "⏱️ Estuve inactivo durante {minutes} min sin avanzar.",
    "gateway.progress.timeout_stuck_tool": "El asistente parece atascado ({seconds} s desde la última actividad, {progress}).",
    "gateway.progress.timeout_last_activity": "Sin actividad desde hace {seconds} s ({progress}).",
    "gateway.progress.timeout_hint": "Probá de nuevo o escribí /new para empezar una conversación nueva.",
    "gateway.busy.running_tool": "consultando CloudISP",
    "gateway.busy.behavior_queue_long": "Los mensajes se pondrán en cola para el siguiente turno mientras el asistente esté ocupado.",
    "gateway.busy.behavior_interrupt_long": "Los mensajes interrumpirán la ejecución actual mientras el asistente esté ocupado.",
    "gateway.busy.demoted_tail": " — tu mensaje queda en cola para cuando termine.",
    "gateway.busy.slash_rejected": "⏳ Estoy trabajando: ese comando no se puede usar a mitad de una tarea. Esperá la respuesta actual.",
    # Clarify card: the "skip" hint is dropped ("(Recommended)" is removed by the runtime patch).
    "gateway.clarify.skip_hint": "",
    "gateway.clarify.expired": "⏳ Esta pregunta expiró. Pedímelo de nuevo.",
    "platform.telegram.prompt.expired_toast": "⚠️ Esta pregunta expiró.",
    "platform.telegram.prompt.expired_body": "⚠️ Esta pregunta expiró o la conversación se reinició. Pedímelo de nuevo.",
    # Approval card of a write (the card body is rewritten by the runtime patch: action label + detail).
    "gateway.exec_approval.header": "Necesito tu confirmación para esta acción",
    "gateway.exec_approval.reason_label": "Detalle",
    "gateway.exec_approval.default_reason": "sin detalles",
    "gateway.exec_approval.deadline": "Si no respondés en {window}, la acción NO se ejecuta.",
    "gateway.exec_approval.timed_out_notice": "⌛ La confirmación expiró tras {window}: la acción NO se ejecutó. Pedímelo de nuevo si todavía la querés.",
    "gateway.exec_approval.action_once": "✅ Aprobar",
    "gateway.exec_approval.action_session": "✅ Aprobar",
    "gateway.exec_approval.action_always": "✅ Aprobar",
    "gateway.exec_approval.action_deny": "❌ Denegar",
    "platform.telegram.approval.resolved_once": "✅ Aprobada",
    "platform.telegram.approval.resolved_session": "✅ Aprobada",
    "platform.telegram.approval.resolved_always": "✅ Aprobada",
    "platform.telegram.approval.resolved_deny": "❌ Denegada",
    "platform.telegram.approval.expired": "⌛ Confirmación expirada",
    "platform.telegram.approval.expired_detail": "{label} — la acción ya no estaba esperando confirmación (venció el tiempo o se resolvió en otro lugar).",
    "approval.timeout": "      ⏱ Sin respuesta en {waited}: la acción no se ejecutó.",
    # Restart and outage notices (a home channel makes the runtime send these): no brand, no commands the plugin blocks.
    "gateway.startup.online": "♻️ El asistente está en línea de nuevo.",
    "gateway.shutdown.notice_shutdown": "⚠️ El asistente se está apagando: tu tarea actual se interrumpirá. Cuando vuelva, escribime de nuevo y seguimos.",
    "gateway.shutdown.notice_restart": "⚠️ El asistente se está reiniciando: tu tarea actual se interrumpirá. Escribime de nuevo en un minuto y seguimos.",
    "gateway.errors.auth_failed": TRY_AGAIN_TEXT,
    "gateway.errors.connection_interrupted": TRY_AGAIN_TEXT,
    "gateway.errors.unreachable": TRY_AGAIN_TEXT,
    "gateway.errors.connection_unknown": TRY_AGAIN_TEXT,
    "gateway.errors.provider_kept_failing": TRY_AGAIN_TEXT,
    "gateway.errors.generic_failed": TRY_AGAIN_TEXT,
    "gateway.errors.generic_failed_with_hint": TRY_AGAIN_TEXT,
    "gateway.errors.no_credentials": TRY_AGAIN_TEXT,
    "gateway.errors.history_unavailable": TRY_AGAIN_TEXT,
    "gateway.errors.stopped_before_finishing": "⚠️ Tuve que detenerme antes de terminar. Escribí de nuevo tu pedido o /new para empezar una conversación nueva.",
    "gateway.errors.unexpected_silence": "⚠️ No pude armar una respuesta para ese mensaje. Probá de nuevo o reformulalo.",
    "gateway.errors.hint_auth": "",
    "gateway.errors.hint_quota": "",
    "gateway.errors.hint_overloaded": "",
}

# `display.status_phrases` (config.yaml): what the generic heartbeat says. The runtime's defaults are English.
STATUS_PHRASES = {
    "status": ["sigo en eso", "sigo trabajando en tu pedido", "todavía estoy consultando", "esto tarda un poco pero sigo", "esperando el resultado"],
    "generic": ["en eso", "un momento", "consultando CloudISP"],
}
