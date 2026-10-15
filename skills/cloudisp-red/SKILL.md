---
name: cloudisp-red
description: "Depuración de red de solo lectura con el servidor MCP cloudisp: ONUs por modelo y firmware, ONUs offline, consumo de un abonado y ranking de uso por plataforma, OLT o PON, tráfico en vivo, estado y sondeos de OLTs, health checks de routers, masters EoC y tareas de equipo recientes. Usala para 'qué ONU tiene menos tráfico', 'listado de abonados con tal modelo o firmware', 'cuántas ONUs hay de tal modelo', 'cuánto consume el abonado', 'por qué falló la tarea', 'cómo está la OLT, el router o el master EoC'."
license: MIT
compatibility: Requiere el servidor MCP cloudisp (https://github.com/CloudISP/cloudisp-mcp).
---

# Red: depuración de solo lectura

Respondé en **español**. Todo esto es **lectura**: no pide confirmación. Sobre el
equipamiento de red (routers, OLTs, masters EoC, plataformas) el agente **lee todo
y no escribe nada**: si piden cambiar algo de un equipo, explicá que es tarea de un
manager en el admin. Para varias lecturas en paralelo podés usar subagentes con la
consigna "Reglas: solo lectura, llamá cloudisp_context primero, dato faltante = no
disponible".

Reglas de los datos: lo que no vino es **"no disponible"** (nunca `0`); las horas ya
vienen en hora de Salta (`-03:00`); informá siempre la fecha de captura. Bytes en
MB/GB y velocidades en Mbps (los `*_bps` dividen por 1.000.000).

## Flota de ONUs: modelo y firmware

- **`list_onu_models`** (`platform_id` opcional): una fila por modelo
  (`product_class`) y firmware, con `onus`, `online`, `offline` y `sync_template`.
  Un `sync_template` vacío significa **"modelo no adaptado"** para sincronizar.
- **`list_onus`** con `product_class` y `firmware` **exactos** (los de
  `list_onu_models`), `platform_id`, `olt_id` / `pon_slot` / `pon_port`, `state`
  u `offline_only`. Cada fila trae `offline_since`, `acs` (`product_class`,
  `firmware`, `adapter`, `sync_template`, `last_inform_at`, `wifi_channel_24`,
  `wifi_channel_5`; `null` si la ONU no tiene datos del ACS) y `client` (`id`,
  `name`). `meta.total` es el total: con `per_page=1` solo contás; paginá con `page`
  (hasta 100 por página) para listar.
- "Abonados con ONU de tal tipo" (por ejemplo "WiFi 4"): partí de
  `list_onu_models`, elegí los modelos que correspondan **según lo que dice el
  dato** y listá cada uno con `list_onus`. No adivines qué modelo es de qué
  generación: si no se desprende del dato, preguntá.

## Consumo

- **`subscriber_usage`** (`window`: `24h`, `7d`, `30d`): bytes de bajada y subida,
  picos en bps, `last_sample_at` y hasta 48 intervalos. Sin muestras vuelve `null`
  con un motivo: es "no disponible", **no** es consumo cero.
- **`usage_ranking`** (`window`: `24h` o `7d`; `order`: `asc` = menos tráfico
  primero, `desc` = más; `limit` hasta 50; filtros `platform_id`, `olt_id`,
  `pon_slot`, `pon_port`). Los abonados de `no_data` no tienen muestras: listalos
  aparte y no los cuentes como "menos tráfico". "¿Qué ONU tiene menos tráfico?" →
  `order: asc`, y cruzá cada `client_id` con `list_onus` o `get_subscriber`.
- **`live_traffic`**: tráfico de la sesión PPPoE **ahora**: `download_bps` y
  `upload_bps`. Arranca una observación corta en el router, así que puede tardar
  unos segundos; si responde `pending`, volvé a llamarlo.
- Para el panorama de la plataforma: `network_snapshot` (sesiones online y
  throughput WAN; sin `platform_id` suma todas las plataformas visibles y trae el
  detalle en `platforms[]`). No es consumo ni porcentaje de saturación.

## OLT, PON, router y EoC

- **OLT:** `list_olts`; `get_olt` (por PON: total, online, offline, peor RX);
  `olt_poll_runs` (últimos sondeos con su estado y error: un sondeo fallido
  significa datos viejos, decilo); `olt_read` con `olt.health_check` para una
  lectura en vivo.
- **Router MikroTik:** `list_routers` (resumen de salud); `get_router` (últimos 20
  health checks, estado del breaker y capacidad WAN); `router_read` con
  `routeros.health_check`, `routeros.test_command` o
  `routeros.interface_monitor_traffic`.
- **Masters EoC** (La Merced): `list_eoc_masters` (estado, último visto y CPEs
  contados). Solo lectura.
- **Telemetría y eventos:** `device_metrics` (catálogo y series de un router u
  OLT), `network_alerts`, `platform_logs` (`platform_id` obligatorio, hasta 7
  días).

## Qué se intentó y por qué falló

- **`device_tasks`** con `kind` (`routeros` u `olt`) y `device_id`, **o** con un
  abonado (`subscriber_id` / `subscriber_query`: su ONU y su router): las últimas
  tareas con `task_type`, `status`, `error_type` y `error_message` corto. Sirve
  para ver si ya se intentó algo y cómo terminó. Nunca trae el resultado: para eso
  `get_task` con el `task_run_id`.
- Un `get_task` que responde `{"ok": false, "outcome": "device_error"}` es una
  tarea que terminó pero cuyo equipo no hizo lo pedido (`onu_offline`,
  `restart_not_observed`): no es un éxito.

## Cómo responder

Cerrá con tres bloques, en formato Telegram (viñetas, sin tablas anchas):

- **Veredicto** — en **negrita**, una línea.
- **Evidencia** — 3 a 6 viñetas con los números leídos, sus unidades y la fecha de
  captura. Lo que no vino es "no disponible".
- **Siguiente paso** — lo que recomendás (una OT de visita, mirar otra OLT,
  esperar un sondeo). Si implica una escritura sobre un abonado, se ofrece con
  botones y las reglas de `cloudisp-operator`.

Basate solo en datos leídos; nunca inventes un diagnóstico ni una causa.
