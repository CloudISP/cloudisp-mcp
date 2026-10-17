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

Cruzá en este orden: estado, deuda y problemas activos → sesión PPPoE → ONU
(estado, RX) → TR-069/WiFi → OLT/PON (vecinos caídos = falla de red) → router →
logs → OTs abiertas.

## Árbol de decisión

1. **Un solo abonado.** `find_subscriber`: exactamente uno. Si hay varios,
   preguntá cuál (`id — nombre`, dirección para homónimos). Si pidieron varios
   abonados, hacé una lectura por abonado en paralelo con subagentes (solo
   lectura).
2. **`diagnose_subscriber`.**
   - `billing.open_cutoff` verdadero → veredicto **"corte por deuda"**. Ofrecé la
     reconexión **solo si la piden**. Mencioná la deuda con su moneda
     (`billing.debt_by_currency` trae una fila por moneda con `debt_cents` y
     `overdue_cents`: **nunca sumes ARS con USD**), el `oldest_due_date` y el
     `last_payment` (monto, moneda, método y origen; `null` si nunca pagó). Para
     el detalle de movimientos usá `get_account_statement`.
   - `problems` son los **problemas activos** del abonado (alertas abiertas o
     reconocidas sobre él, su ONU, su puerto PON o su OLT): es la primera tarjeta
     del Resumen. Si `state` no es `ok`, decí "no disponible"; una alerta que
     nombra la OLT o el PON ya orienta a falla de red.
   - `service` es el plan contratado (nombre, velocidades, `price_cents` con
     moneda y `since`); `found: false` significa que no hay contrato activo, no un
     plan vacío. `subscriber` trae los nombres de perfil, nodo y OLT.
   - `lifecycle_status` distinto de `active` → informalo.
   - Una sección en `null` (ver `section_errors`) = "no disponible".
3. **¿Hay sesión PPPoE activa?** (`network_context` / `consumption`).
   - **Sí** → el problema es WiFi/LAN o una sesión colgada. Mirá el tráfico real
     con `live_traffic` (`download_bps` / `upload_bps`) y `subscriber_usage`. Sin
     tráfico y con sesión → ofrecé `kick_pppoe` (cierra la sesión PPPoE y el CPE
     reconecta). Con tráfico → hacé `onu_read` con `onu.wifi_read` y
     `onu.wifi_diagnose`, y ofrecé cambio de canal o de WiFi
     (`change_wifi_radio` / `change_subscriber_wifi`); `optimize_wifi` en
     `preview` propone canales sin tocar nada. Si dudan de la clave WiFi,
     `onu_read` con `onu.wifi_password_check` (`parameters.ssid_index`) dice si
     coincide con la registrada, sin mostrarla.
4. **Sin sesión → mirá la ONU.**
   - `state` `offline` → `list_onus` del mismo PON (`olt_id`, `pon_slot`,
     `pon_port`).
     - **Varios vecinos caídos** → falla de PON/OLT. Mirá primero `problems`
       (la alerta de PON u OLT que lo afecta), después `olt_read` con
       `olt.health_check` y `network_alerts`, y **escalá sin tocar al abonado**.
     - **Cae solo ella** → ofrecé una OT de visita técnica.
   - Online con RX en banda **critical** (menor a −28 dBm) → problema óptico:
     ofrecé OT de visita. En banda **warning** (de −25 a −28 dBm) la señal está
     degradada y puede causar lentitud o microcortes: decilo y ofrecé la OT si el
     abonado tiene esos síntomas. `list_onus` del abonado (`client_id`) ya trae
     `optical.band` con estas bandas del admin (`ok` desde −25 dBm); si el RX sale
     del diagnóstico, aplicá los mismos umbrales. `optical` en `null` es "no
     disponible", no señal buena.
   - Online con RX OK y sin PPPoE → `onu_diagnose` (sync solo lectura).
     - Si detecta un canal faltante o incorrecto → ofrecé `sync_onu`.
     - Si la ONU perdió su configuración (WAN o TR-069 ilegibles, por ejemplo
       tras un restablecimiento) → ofrecé `reprovision_onu`.
     - Si responde `sync_template_missing` → **"modelo no adaptado"**: ofrecé
       reinicio (`reboot_onu`) y, si falla, la OT.
5. **Si sigue sin resolverse:** `device_tasks` con el abonado (qué se intentó en
   su ONU y su router y por qué falló), `platform_logs` (syslog del router/OLT de
   la plataforma del abonado, últimas 2 h, filtrado por el usuario PPPoE con `q`)
   y `router_read` con `routeros.test_command` (`command` `/interface/print`) y
   `list_routers`. Las horas ya vienen en hora de Salta (`-03:00`).
6. **Reinicio fallido:** un reinicio que falló, o que terminó con `device_error`
   (`onu_offline` o `restart_not_observed`: la ONU nunca volvió), cuenta como
   fallido. Ofrecé `create_work_order` con `type` `technical_visit` y la
   descripción: *"Esta ONU no pudo ser reiniciada remotamente, se recomienda una
   visita técnica. Se puede solicitar al abonado que apague y vuelva a prender su
   equipo."* (ver `cloudisp-ordenes-trabajo`). No ofrezcas
   `factory_reset_onu` salvo que el técnico lo pida: es el último recurso.
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
