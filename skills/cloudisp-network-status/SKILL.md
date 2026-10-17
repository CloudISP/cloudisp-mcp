---
name: cloudisp-network-status
description: "Estado de red de CloudISP con el servidor MCP cloudisp: abonados online y throughput WAN (network_snapshot), alertas, estado y métricas de OLTs y routers MikroTik, y syslog. Usala para preguntas de cuántos abonados hay conectados, estado de la red, cómo está el MikroTik o la OLT, alertas, network status, online subscribers o WAN throughput."
license: MIT
compatibility: Requiere el servidor MCP cloudisp (https://github.com/CloudISP/cloudisp-mcp).
---

# Estado de red

Respondé en **español**. Todo esto es solo lectura: no requiere confirmación.

## Resumen general — `network_snapshot`

Llamalo sin argumentos (todas las plataformas visibles) o con `platform_id`, e
informá solo lo que devuelve:

- **Abonados online** — `clients_online` con su fecha de captura.
- **Throughput WAN** — bajada y subida en Mbps, con la interfaz y su fecha de
  captura.
- Valores `null` o `projection_unavailable` → **"no disponible"**. Nunca
  informes `0` por un dato faltante.
- Incluí siempre la fecha de captura para que se sepa qué tan fresco es el dato.
- El **reporte de consumo de 24 horas no está disponible**
  (`usage_24h.available` es siempre `false`). No lo estimes ni presentes el
  throughput como consumo o como porcentaje de saturación.
- Sin `platform_id` el snapshot suma **todas las plataformas visibles** y trae el
  detalle en `platforms[]`; con `platform_id` (2, 3, 4 o 15) es solo esa. No es
  tráfico por abonado: para eso `subscriber_usage` y `usage_ranking`
  (`cloudisp-red`).

## Estado de equipos

- **OLTs** — `list_olts` y `get_olt` (resumen por PON: total, online, offline,
  peor RX en dBm); `olt_read` con `olt.health_check` para una lectura en vivo.
- **Routers MikroTik** — `list_routers` (salud) y `router_read` con
  `routeros.health_check`, `routeros.test_command` (`command`: `/system/identity/print`, `/system/resource/print`, `/interface/print` o `/ip/address/print`) o `routeros.interface_monitor_traffic`.
- **Alertas** — `network_alerts`.
- **Métricas** — `device_metrics` (`kind`: `routeros` u `olt`, `device_id`): sin
  `metric_ids` devuelve el catálogo (con `search`, `selected`, `limit`… para acotarlo);
  con `metric_ids`, las series. Los ids son opacos (64 caracteres hexadecimales)
  y salen del catálogo: nunca uses nombres como `cpu`. `window`: `15m`, `1h`, `6h`,
  `24h`, `7d` o `30d`; `resolution`: `auto`, `raw` o `trend_1h`.
- **Logs** — `platform_logs` (`platform_id` obligatorio, rango máx. 7 días): por
  ejemplo el syslog del router de las últimas 2 h filtrado por un usuario PPPoE
  (`q`).

## Recomendaciones de red

Basate solo en datos leídos: peor RX por PON (`get_olt`), ONUs offline por PON
(`list_onus`), alertas y métricas. Si un dato no vino, es "no disponible".
Nunca inventes un diagnóstico.
