---
name: cloudisp-network-status
description: "Estado de red de CloudISP con el servidor MCP cloudisp: abonados online y throughput WAN (network_snapshot), alertas, estado y métricas de OLTs y routers MikroTik, y syslog. Usala para preguntas de cuántos abonados hay conectados, estado de la red, cómo está el MikroTik o la OLT, alertas, network status, online subscribers o WAN throughput."
license: MIT
compatibility: Requiere el servidor MCP cloudisp (https://github.com/CloudISP/cloudisp-mcp).
---

# Estado de red

Respondé en **español**. Todo esto es solo lectura: no requiere confirmación.

## Resumen general — `network_snapshot`

Llamalo sin argumentos e informá solo lo que devuelve:

- **Abonados online** — `clients_online` con su fecha de captura.
- **Throughput WAN** — bajada y subida en Mbps, con la interfaz y su fecha de
  captura.
- Valores `null` o `projection_unavailable` → **"no disponible"**. Nunca
  informes `0` por un dato faltante.
- Incluí siempre la fecha de captura para que se sepa qué tan fresco es el dato.
- El **reporte de consumo de 24 horas no está disponible**
  (`usage_24h.available` es siempre `false`). No lo estimes ni presentes el
  throughput como consumo o como porcentaje de saturación.
- El snapshot es de la plataforma a la que pertenece la clave; no es tráfico por
  abonado.

## Estado de equipos

- **OLTs** — `list_olts` y `get_olt` (resumen por PON: total, online, offline,
  peor RX en dBm); `olt_read` con `olt.health_check` para una lectura en vivo.
- **Routers MikroTik** — `list_routers` (salud) y `router_read` con
  `routeros.health_check`, `routeros.resource_read` o `routeros.ppp_active_read`.
- **Alertas** — `network_alerts`.
- **Métricas** — `device_metrics` (`kind`: `routeros` u `olt`, `device_id`): sin
  `metric_ids` devuelve el catálogo; con `metric_ids`, las series.
- **Logs** — `platform_logs` (`platform_id` obligatorio, rango máx. 7 días): por
  ejemplo el syslog del router de las últimas 2 h filtrado por un usuario PPPoE
  (`q`).

## Recomendaciones de red

Basate solo en datos leídos: peor RX por PON (`get_olt`), ONUs offline por PON
(`list_onus`), alertas y métricas. Si un dato no vino, es "no disponible".
Nunca inventes un diagnóstico.
