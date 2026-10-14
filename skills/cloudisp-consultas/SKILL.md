---
name: cloudisp-consultas
description: "Consultas de solo lectura en CloudISP con el servidor MCP cloudisp: buscar o consultar abonados, perfiles, planes, facturas, órdenes de trabajo, técnicos, ONUs, OLTs, routers y reportes. Usala cuando pidan buscar/consultar un abonado, ver planes o facturas, listar órdenes, estado de OLTs o routers, o correr un reporte (find subscriber, list plans, work orders, ONUs offline, report)."
license: MIT
compatibility: Requiere el servidor MCP cloudisp (https://github.com/CloudISP/cloudisp-mcp).
---

# Consultas CloudISP (solo lectura)

Respondé en **español**. Aplicá las reglas de `cloudisp-operator`. Estas
herramientas no modifican nada: no hace falta confirmación.

## Abonados — `find_subscriber`, `get_subscriber`

- Buscá con `query` (nombre, apellido, fragmento de documento o dirección; mínimo
  2 caracteres). Leé `meta.total` para saber cuántos coinciden.
- Si hay varios, listá `id — nombre` y, para distinguir homónimos, la dirección
  o localidad. Preguntá cuál antes de seguir.
- `get_subscriber` y el resto de las herramientas por abonado aceptan
  `subscriber_id` o `subscriber_query` (exactamente uno).
- Nunca muestres documento, teléfono ni email.

## Perfiles, planes y facturas

- `list_internet_profiles` (sin argumentos): `id`, nombre, `download_max_limit` y
  `upload_max_limit` tal como vienen (Mbps). "Cuántos perfiles" = contá `data`.
- `list_plans` (`status` opcional): planes comerciales con su `id`.
- `list_invoices` (`subscriber_id`/`subscriber_query`, `status`): el pago no
  cambia el `status`; la deuda es `balance_cents`.

## Órdenes de trabajo — `find_work_orders`, `get_work_order`

- Filtrá por `subscriber_id` (preferido, obtenido de `find_subscriber`) o por
  `subscriber_query`, más `type` y `status` opcionales.
- Si el `subscriber_query` coincide con varios abonados, la herramienta devuelve
  los candidatos y no lista órdenes: preguntá cuál.
- Informá `id`, tipo, estado y técnico asignado si viene.

## Técnicos — `find_technician`

- Buscá por fragmento de nombre. Devolvé `employee_id` y nombre.
- Sin resultados: decí que no hay un técnico activo con ese nombre; no inventes.

## Red — ONUs, OLTs, routers, reportes

- `list_onus` (`state`, `olt_id`, `pon_slot`, `pon_port`, abonado): `meta.total`
  es el conteo completo; para "cuántas ONUs offline hay" usá `state: offline` y
  `per_page: 1`.
- `list_olts` / `get_olt`: OLTs y su resumen por PON (total, online, offline,
  peor RX). `list_routers`: routers con su salud.
- `network_alerts`, `device_metrics` y `platform_logs`: ver `cloudisp-network-status`.
- `list_reports` y `run_report` (`key`, `platform_id`, `filters`): reportes de
  gestión (ONUs offline, abonados sin ONU, etc.). Resumilos; no pegues tablas
  enormes en el chat.

## Formato de respuesta

- Respuestas cortas, con los ids para que el operador pueda seguir.
- Lo que no vino en la respuesta es **"no disponible"**.
