---
name: cloudisp-ordenes-trabajo
description: "Crear y asignar órdenes de trabajo (instalación, visita técnica, servicio técnico) en CloudISP con el servidor MCP cloudisp, cambiar su estado y consultar las existentes. Usala para pedidos de cargar una instalación, abrir una visita técnica, asignar una orden a un técnico, cancelar o cerrar una OT, ver OTs pendientes o create/assign work order."
license: MIT
compatibility: Requiere el servidor MCP cloudisp (https://github.com/CloudISP/cloudisp-mcp).
---

# Órdenes de trabajo

Respondé en **español**. Aplicá las reglas de `cloudisp-operator`: toda
escritura lleva resumen, confirmación con botones e
`idempotency_key`.

## Consultar (solo lectura)

- `find_work_orders` con `subscriber_id` o `subscriber_query` y, opcional,
  `type`, `status` (`pending`, `in_progress`, `completed`, `cancelled`),
  `priority` (`low`, `medium`, `high`), `assigned_to` (id de un técnico de
  `find_technician`), `scheduled_from` / `scheduled_to` (`YYYY-MM-DD`) y
  `overdue: true` (la cita pasó y la OT sigue abierta: las "vencidas" del
  admin). Si el `subscriber_query` coincide con varios abonados, devuelve los
  candidatos y no lista: preguntá cuál.
- `get_work_order` con `work_order_id` para el detalle: trae `created_by` (el
  vendedor de la venta) y el timeline — `history` y `comments`, los 50 más
  recientes de cada uno, más nuevos primero. Leé los comentarios antes de
  cambiar una OT: suelen explicar por qué está como está.
- Informá `id`, tipo, estado y técnico asignado si viene.

## Crear — `create_work_order`

1. Resolvé el abonado (`find_subscriber`; ante `ambiguous_subscriber` listá
   `id — nombre` y preguntá).
2. Elegí `type`: `installation`, `technical_visit` (visita técnica),
   `technical_service`, `reconnection`, `removal`, `equipment_change`, `other`
   u otro de los tipos de CloudISP. `title` de 1 a 160 caracteres; `description`
   y `priority` son opcionales.
3. **Confirmá** (abonado + id, plataforma, tipo, título, descripción) con los
   botones `✅ Confirmar` / `❌ Cancelar`.
4. Llamá `create_work_order` con `subscriber_id`, `type`, `title` e
   `idempotency_key` (`agent-<yyyymmddhhmmss>-ot-<subscriber_id>`; también
   queda como referencia externa de la OT, máx. 100 caracteres).
5. Informá el `id` de la OT. `replayed: true` → **"ya estaba creada"**.

### Visita técnica por reinicio fallido

Si `reboot_onu` falló o terminó con `device_error` (`onu_offline`,
`restart_not_observed`), ofrecé una OT `technical_visit` con esta descripción:

> Esta ONU no pudo ser reiniciada remotamente, se recomienda una visita técnica.
> Se puede solicitar al abonado que apague y vuelva a prender su equipo.

Antes de crearla mirá si ya hay una visita pendiente del abonado
(`find_work_orders`, `type: technical_visit`, `status: pending`).

### Cambio de ONU (OT `equipment_change`)

Cuando hay que reemplazar la ONU de un abonado, el técnico trae la MAC de la
nueva y se hace en dos pasos, cada uno con su confirmación:

1. `locate_new_onu` con `subscriber_id` y `mac` busca la ONU nueva en las OLT de
   la plataforma del abonado (una búsqueda por OLT; solo lee). Devuelve
   `matches` con `olt_name`, `network_onu_id`, `serial`, `pon_slot`, `pon_port`,
   `model`, `state` y `linked_client_id`. Sin coincidencias, o con una ya
   vinculada a otro abonado (`linked_client_id`), no sigas: decilo.
2. Confirmá con el técnico cuál es (OLT, PON y serial) y llamá `swap_onu` con
   `network_onu_id`, `serial` y `mac` de esa coincidencia; `ssid_24`, `ssid_5`,
   `wifi_password` y `keep_password` solo si los pide. Espera hasta 110 s.
   `onu_serial_mismatch`, `onu_mac_mismatch` u `onu_not_found` → volvé a ubicarla.
   `onu_belongs_to_other_client` → la ONU es de otro abonado: no sigas.

## Asignar — `assign_work_order`

1. **La orden:** pasá `work_order_id` (el que devolvió `create_work_order` o
   `find_work_orders`) **o** el abonado (`subscriber_id` / `subscriber_query`)
   más `type`. Con abonado + `type`, la herramienta exige exactamente **una**
   orden pendiente de ese tipo.
2. **El técnico:** `employee_id` (de `find_technician`) o `technician_query`
   (fragmento de nombre; debe coincidir con un solo técnico activo).
3. **Confirmá** la orden (id + abonado) y el técnico (`employee_id` + nombre).
4. **Ambigüedad** — nunca elijas vos:
   - `ambiguous_work_order` → listá las órdenes candidatas (`id`, tipo, estado)
     y preguntá cuál.
   - `ambiguous_technician` → listá los técnicos (`id` + nombre) y preguntá.
5. **Informar** — éxito: id de la orden y `assigned_to`. `replayed: true` →
   **"ya estaba asignada"**.

"Cargá una instalación y asignala a Olivera" son **dos acciones**: confirmá y
ejecutá `create_work_order`; después confirmá y ejecutá `assign_work_order` con
el `work_order_id` recién creado.

## Cambiar el estado — `update_work_order_status`

1. Mirá la OT con `get_work_order` y decí en qué estado está.
2. `status`: `in_progress` (iniciar una OT pendiente), `completed` (cerrar una
   OT que **no** es instalación) o `cancelled` (cancelar). Para cancelar,
   `reason` es obligatorio y de hasta 500 caracteres: el motivo queda en la OT
   y lo ve el admin, así que pedilo tal cual lo dijo el operador.
3. **Confirmá** (OT + abonado, estado actual → estado nuevo y, si cancela, el
   motivo textual) con los botones `✅ Confirmar` / `❌ Cancelar`.
4. Llamá `update_work_order_status` con `work_order_id`, `status`, `reason` e
   `idempotency_key` (`agent-<yyyymmddhhmmss>-ot-estado-<work_order_id>`).
5. Informá el estado nuevo. `replayed: true` → **"ya estaba en ese estado"**.

**Una instalación no se completa así.** Una OT de instalación (`installation`,
`catv_installation`, `eoc_installation`) se cierra con el formulario de cierre
(precinto y firma) desde el admin: el intento devuelve `validation_failed` y no
cambia nada. Si piden cerrarla, decí que se cierra desde la app de instalación,
no insistas con la herramienta.

`illegal_transition` (completar una OT pendiente, saltar estados o reabrir una
cerrada): informalo y frená; la tabla de transiciones la decide el servidor, y
reabrir o corregir una OT cerrada es una acción de manager en el admin.

Si la orden no está pendiente o no hay orden de ese tipo para el abonado,
decilo; no inventes un id. `platform_policy_denied`, `actor_forbidden` o
`daily_write_limit_reached`: informalo y frená.
