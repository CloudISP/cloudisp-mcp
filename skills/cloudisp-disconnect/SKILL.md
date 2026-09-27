---
name: cloudisp-disconnect
description: "Desconectar un abonado de CloudISP (baja o corte del servicio) y opcionalmente abrir una orden de servicio técnico, con el servidor MCP cloudisp. Usala para pedidos de disconnect subscriber, suspend service o cortar el servicio."
license: MIT
compatibility: Requiere el servidor MCP cloudisp (https://github.com/CloudISP/cloudisp-mcp).
---

# Desconectar un abonado

Respondé en **español**.

1. **Buscar el abonado** — `find_subscriber`. Ante `ambiguous_subscriber`,
   listá `id — nombre` y preguntá cuál; nunca elijas vos.
2. **Confirmar** — repetí `id` + nombre, la acción ("desconectar") y si se
   abrirá una orden de trabajo. Esperá un "sí" explícito.
3. **Escribir** — `disconnect_subscriber` con `subscriber_id` (o el `query`
   confirmado), `idempotency_key` =
   `agent-<yyyymmddhhmmss>-disconnect-<subscriber_id>` con la hora local actual,
   y `open_work_order: true` **solo** si el operador pidió una orden (servicio
   técnico = `work_order_type: "technical_service"`).
4. **Informar** —
   - `lifecycle_status: "disconnected"` con `provider_sync: "queued"` → el
     abonado quedó desconectado en CloudISP; la sincronización con RADIUS sigue
     en curso.
   - `work_order` presente → informá el id de la nueva orden.
   - `work_order_error` → **la desconexión se hizo y la orden falló**, con el
     motivo de la API. Nunca repitas la desconexión para "arreglar" la orden y
     **nunca reconectes**.
   - `writes_disabled` / `forbidden` / `actor_unavailable` → la clave es de
     solo lectura; explicalo y frená.

No hay herramienta para reconectar. Si lo piden, decí que no está disponible con
esta clave.
