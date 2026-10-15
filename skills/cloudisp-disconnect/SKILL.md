---
name: cloudisp-disconnect
description: "Cortar o reconectar el servicio de un abonado de CloudISP (internet, CATV o todo) y opcionalmente abrir una orden de servicio técnico, con el servidor MCP cloudisp. Usala para pedidos de disconnect/reconnect subscriber, suspend service, cortar o reconectar el servicio."
license: MIT
compatibility: Requiere el servidor MCP cloudisp (https://github.com/CloudISP/cloudisp-mcp).
---

# Cortar o reconectar un abonado

Respondé en **español**. Aplicá las reglas de `cloudisp-operator`. Cortar y
reconectar son acciones de impacto directo en el servicio: confirmá siempre y
una sola por vez.

## Cortar — `disconnect_subscriber`

1. **Buscar el abonado** — `find_subscriber`. Ante `ambiguous_subscriber`,
   listá `id — nombre` y preguntá cuál; nunca elijas vos.
2. **Alcance** — `scope`: `internet` (por defecto), `catv` o `all`. Si el
   operador no lo aclara, usá `internet` y decilo en el resumen.
3. **Confirmar** — resumen con `id` + nombre, plataforma, alcance, "cortar el
   servicio" y si se abrirá una orden de trabajo. Botones `✅ Confirmar` /
   `❌ Cancelar`.
4. **Escribir** — `disconnect_subscriber` con `subscriber_id` (o el
   `subscriber_query` confirmado), `scope`, `idempotency_key` =
   `agent-<yyyymmddhhmmss>-disconnect-<subscriber_id>` con la hora local actual,
   y `open_work_order: true` **solo** si el operador pidió una orden (servicio
   técnico = `work_order_type: "technical_service"`).
5. **Informar** —
   - `lifecycle_status: "disconnected"` con `provider_sync: "queued"` → el
     abonado quedó desconectado en CloudISP; la sincronización con RADIUS sigue
     en curso.
   - `work_order` presente → informá el id de la nueva orden.
   - `work_order_error` → **la desconexión se hizo y la orden falló**, con el
     motivo de la API. Nunca repitas la desconexión para "arreglar" la orden y
     **nunca reconectes** por tu cuenta.

## Reconectar — `reconnect_subscriber`

Solo si el operador lo pide. Mismo flujo: buscar, `scope`, confirmar,
`reconnect_subscriber` con `idempotency_key` =
`agent-<yyyymmddhhmmss>-reconnect-<subscriber_id>`.

- `illegal_transition` → la reconexión no está disponible (por ejemplo, hay un
  **corte por deuda abierto**); informá el motivo que viene en `details`
  (`availability`) y no insistas.
- Un abonado cortado por deuda no se reconecta para "probar": primero se
  regulariza la deuda.

## Errores comunes

`writes_disabled` / `platform_policy_denied` / `actor_forbidden` /
`daily_write_limit_reached` → informalo y frená; no reintentes.
