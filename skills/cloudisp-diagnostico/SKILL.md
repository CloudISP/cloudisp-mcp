---
name: cloudisp-diagnostico
description: "Diagnosticar por qué un abonado de CloudISP no tiene internet (L1) con el servidor MCP cloudisp: deuda, sesión PPPoE, ONU, potencia óptica, OLT/PON, router, logs y órdenes abiertas. Usala ante pedidos de diagnosticar a un abonado, 'no tiene internet', 'sin servicio', 'está caído' o troubleshoot subscriber (no internet)."
license: MIT
compatibility: Requiere el servidor MCP cloudisp (https://github.com/CloudISP/cloudisp-mcp).
---

# Diagnóstico: abonado sin internet (L1)

Respondé en **español**. Aplicá las reglas de `cloudisp-operator`. Todo el
diagnóstico es **solo lectura**: no pide confirmación. Las escrituras que
resultan del diagnóstico (reiniciar, sincronizar, OT, reconectar) se **ofrecen**
con botones y se hacen solo con confirmación.

Cruzá en este orden: estado y deuda → sesión PPPoE → ONU (estado, RX) →
TR-069/WiFi → OLT/PON (vecinos caídos = falla de red) → router → logs → OTs
abiertas.

## Árbol de decisión

1. **Un solo abonado.** `find_subscriber`: exactamente uno. Si hay varios,
   preguntá cuál (`id — nombre`, dirección para homónimos). Si pidieron varios
   abonados, hacé una lectura por abonado en paralelo con subagentes (solo
   lectura).
2. **`diagnose_subscriber`.**
   - `billing.open_cutoff` verdadero → veredicto **"corte por deuda"**. Ofrecé la
     reconexión **solo si la piden**.
   - `lifecycle_status` distinto de `active` → informalo.
   - Una sección en `null` (ver `section_errors`) = "no disponible".
3. **¿Hay sesión PPPoE activa?** (`network_context` / `consumption`).
   - **Sí** → el problema es WiFi/LAN. Hacé `onu_read` con `onu.wifi_read` y
     `onu.wifi_diagnose` y ofrecé cambio de canal o de WiFi
     (`change_wifi_radio` / `change_subscriber_wifi`).
4. **Sin sesión → mirá la ONU.**
   - `state` `offline` o `los` → `list_onus` del mismo PON (`olt_id`, `pon_slot`,
     `pon_port`).
     - **Varios vecinos caídos** → falla de PON/OLT. Hacé `olt_read` con
       `olt.health_check` y `network_alerts`, y **escalá sin tocar al abonado**.
     - **Cae solo ella** → ofrecé una OT de visita técnica.
   - Online con **RX menor a −27 dBm** → problema óptico: ofrecé OT de visita.
   - Online con RX OK y sin PPPoE → `onu_diagnose` (sync solo lectura).
     - Si detecta un canal faltante o incorrecto → ofrecé `sync_onu`.
     - Si responde `sync_template_missing` → **"modelo no adaptado"**: ofrecé
       reinicio (`reboot_onu`) y, si falla, la OT.
5. **Si sigue sin resolverse:** `platform_logs` (syslog del router/OLT de la
   plataforma del abonado, últimas 2 h, filtrado por el usuario PPPoE con `q`) y
   `router_read` con `routeros.ppp_active_read`.
6. **Reinicio fallido:** ofrecé `create_work_order` con `type`
   `technical_visit` y la descripción: *"Esta ONU no pudo ser reiniciada
   remotamente, se recomienda una visita técnica. Se puede solicitar al abonado
   que apague y vuelva a prender su equipo."* (ver `cloudisp-ordenes-trabajo`).
7. **OTs abiertas:** si ya hay una visita pendiente (`find_work_orders` con
   `status: pending`), mencionala en vez de abrir otra.

## Cómo responder

Cerrá siempre con tres bloques:

- **Veredicto** — en **negrita**, una línea ("**Sin PPPoE: la ONU cae sola, falla
  de acceso**").
- **Evidencia** — 3 a 6 viñetas con los datos leídos (estado, RX en dBm, sesión,
  vecinos del PON, deuda, última lectura con su fecha). Lo que no vino es
  "no disponible".
- **Siguiente paso** — la acción recomendada, ofrecida con botones. Una sola
  acción por confirmación.

Formato para Telegram: viñetas, sin tablas anchas. Nunca muestres contraseñas,
PSK, documentos ni teléfonos.
