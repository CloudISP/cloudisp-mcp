---
name: cloudisp-network-status
description: "Estado de red de CloudISP con la herramienta network_snapshot del servidor MCP cloudisp: abonados online, throughput WAN en Mbps y fecha de captura. Usala para preguntas de cuántos abonados hay conectados, estado de la red, network status, online subscribers o WAN throughput."
license: MIT
compatibility: Requiere el servidor MCP cloudisp (https://github.com/CloudISP/cloudisp-mcp).
---

# Estado de red

Respondé en **español**. Llamá `network_snapshot` (sin argumentos) e informá
solo lo que devuelve.

## Qué informar

- **Abonados online** — `clients_online` con su fecha de captura.
- **Throughput WAN** — bajada y subida en Mbps, con la interfaz y su fecha de
  captura.
- Valores `null` o `projection_unavailable` → **"no disponible"**. Nunca
  informes `0` por un dato faltante.
- Incluí siempre la fecha de captura para que se sepa qué tan fresco es el dato.

## Aclarar siempre que corresponda

- El **reporte de consumo de 24 horas no está disponible**
  (`usage_24h.available` es siempre `false`). No lo estimes ni presentes el
  throughput como consumo o como porcentaje de saturación.
- El snapshot es de la plataforma a la que pertenece la clave; no es tráfico por
  abonado.

Herramienta de solo lectura: no requiere confirmación.
