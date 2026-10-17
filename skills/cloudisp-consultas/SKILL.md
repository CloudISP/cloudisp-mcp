---
name: cloudisp-consultas
description: "Consultas de solo lectura en CloudISP con el servidor MCP cloudisp: buscar o consultar abonados, perfiles, planes, facturas y sus pagos, cuenta corriente, deudores, cortes por cobranza, órdenes de trabajo, técnicos, ONUs, OLTs, routers y reportes. Usala cuando pidan buscar/consultar un abonado, ver planes, facturas o pagos, ver la cuenta corriente o quién debe, ver los cortes por mora, listar órdenes, estado de OLTs o routers, o correr un reporte (find subscriber, list plans, work orders, ONUs offline, report)."
license: MIT
compatibility: Requiere el servidor MCP cloudisp (https://github.com/CloudISP/cloudisp-mcp).
---

# Consultas CloudISP (solo lectura)

Respondé en **español**. Aplicá las reglas de `cloudisp-operator`. Estas
herramientas no modifican nada: no hace falta confirmación.

## Abonados — `find_subscriber`, `get_subscriber`

- Buscá con `query` (mínimo 2 caracteres): alcanza nombre, apellido, documento,
  usuario PPPoE, MAC, teléfono, dirección, localidad, email e id legado, sin
  importar acentos ni mayúsculas, y cada palabra del término debe coincidir (así
  `gonzalez juan` encuentra a Juan González). Un DNI con puntos también sirve
  (`20.111.222` busca `20111222`). Leé `meta.total` para saber cuántos coinciden.
- Con el dato exacto, `find_subscriber` también filtra por `document` (solo
  dígitos), `external_client_id` (solo dígitos) y `status` (`true`/`false`); se
  combinan con AND y alcanza con uno. Un número de abonado (`#1234`) va solo.
- Si hay varios, listá `id — nombre` y, para distinguir homónimos, la dirección
  o localidad. Preguntá cuál antes de seguir.
- `get_subscriber` y el resto de las herramientas por abonado aceptan
  `subscriber_id` o `subscriber_query` (exactamente uno). El detalle trae el
  nombre del perfil técnico, del nodo y de la OLT (`profile_name`, `node_name`,
  `olt_name`) y el plan contratado en `service` (nombre, código, velocidades,
  `price_cents` con su moneda y `since`; `found: false` si no hay contrato).
- Nunca muestres documento, teléfono ni email.

## Perfiles, planes y facturas

- `list_internet_profiles` (`status` opcional: `active` por defecto, `deprecated` o
  `soft_deleted`): `id`, nombre, `download_max_limit` y
  `upload_max_limit` tal como vienen (Mbps). "Cuántos perfiles" = contá `data`.
- `list_plans` (`status` opcional): planes comerciales con su `id`.
- `list_invoices` (`subscriber_id`/`subscriber_query`, `status`: `draft`, `issued`
  o `void`): el pago no cambia el `status`; la deuda es `balance_cents`. Cada factura
  trae `subscriber_name`.
- `get_invoice` (`invoice_id`, de `list_invoices`): cabecera, `lines[]` y `payments[]`
  (importe, `currency`, `method`, `origin`: `mercadopago`, `transfer` o `manual`, y fecha).
  No trae la referencia del pago ni datos del medio de pago: no los pidas ni los inventes.

## Cuenta corriente, deudores y cortes — `get_account_statement`, `list_debtors`, `list_cutoffs`

- Los importes vienen en **centavos** y **nunca se suman monedas distintas**: decí
  «ARS 600,00 y USD 200,00», no un total. Un dato que falta es «no disponible», no 0.
- `get_account_statement` (abonado): `debt_by_currency` es lo que debe hoy (citá eso).
  `entries` va de la más nueva a la más vieja y el `balance_cents` de cada línea es el
  saldo corrido de **su** moneda. Pagina con `page`/`per_page`.
- `list_debtors` (`currency`: `ARS` o `USD`, `query`: 2+ caracteres del nombre): una fila por
  abonado **y moneda**, por moneda y de mayor a menor deuda; un abonado puede aparecer dos
  veces. `meta.total_debt_by_currency` suma **todas** las páginas por moneda. "Quién debe más"
  es la primera fila de la moneda que pidieron; sin moneda, mostrá cada una por separado.
- `list_cutoffs` (`status`: `cut_off` = cortado hoy, `active` = ya reconectado; abonado
  opcional; `history` suma los eventos de corte y reconexión). `debt_cents_at_cutoff` viene con
  `debt_currency`; si ambos son `null` (`currency_ambiguous`) decí «no disponible» y no inventes la moneda.
- Estas respuestas traen el nombre del abonado y nada más: ni documento, teléfono ni email.

## Órdenes de trabajo — `find_work_orders`, `get_work_order`

- Filtrá por `subscriber_id` (preferido, obtenido de `find_subscriber`) o por
  `subscriber_query`, más `type` y `status` opcionales.
- Si el `subscriber_query` coincide con varios abonados, la herramienta devuelve
  los candidatos y no lista órdenes: preguntá cuál.
- Informá `id`, tipo, estado y técnico asignado si viene.

## Técnicos — `find_technician`

- Buscá por fragmento de nombre. La lista trae solo quienes `assign_work_order` acepta. Devolvé `employee_id`, nombre y `role`.
- Sin resultados: decí que no hay un técnico activo con ese nombre; no inventes.

## Red — ONUs, OLTs, routers, reportes

- `list_onus` (`state`: `online`, `offline`, `unknown` o `absent`, `olt_id`,
  `pon_slot`, `pon_port`, `platform_id`, `product_class`, `firmware`,
  `offline_only`, `serial` / `mac` (o por prefijo), abonado): `meta.total` es el
  conteo completo; para "cuántas ONUs offline hay" usá `state: offline` y
  `per_page: 1`. Modelos y firmware, consumo y tareas de equipo:
  `cloudisp-red`.
- `list_olts` / `get_olt`: OLTs y su resumen por PON (total, online, offline,
  peor RX). `list_routers`: routers con su salud.
- `network_alerts`, `get_alert`, `device_metrics` y `platform_logs`: ver `cloudisp-network-status`.
- `list_reports` y `run_report` (`key`, `platform_id`, `filters`): reportes de
  gestión (ONUs offline, abonados sin ONU, etc.). Resumilos; no pegues tablas
  enormes en el chat.

## Formato de respuesta

- Respuestas cortas, con los ids para que el operador pueda seguir.
- Lo que no vino en la respuesta es **"no disponible"**.
