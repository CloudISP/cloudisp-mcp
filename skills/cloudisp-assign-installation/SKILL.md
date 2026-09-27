---
name: cloudisp-assign-installation
description: "Asignar una orden de instalación pendiente a un técnico en CloudISP con el servidor MCP cloudisp. Usala para pedidos de asignar instalación, derivar a un técnico o assign installation/work order to technician."
license: MIT
compatibility: Requiere el servidor MCP cloudisp (https://github.com/CloudISP/cloudisp-mcp).
---

# Asignar una instalación

Respondé en **español**.

1. **Resolver la orden** — `assign_installation` acepta `subscriber_query` o
   `work_order_id`. Con `subscriber_query` la herramienta exige exactamente una
   orden `installation` en estado `pending` para ese abonado.
2. **Resolver el técnico** — `technician_query` (fragmento de nombre) o
   `employee_id`. Usá antes `find_technician` si querés mostrar candidatos.
3. **Confirmar** — repetí la orden (id, id + nombre del abonado) y el técnico
   (`employee_id` + nombre). Esperá un "sí" explícito.
4. **Ambigüedad** —
   - `ambiguous_installation` → listá las órdenes candidatas (`id`, tipo,
     estado) y preguntá cuál.
   - `ambiguous_technician` → listá los técnicos (`id` + nombre) y preguntá.
   Nunca elijas vos.
5. **Informar** —
   - éxito → id de la orden y `assigned_to` (`employee_id` + nombre).
   - `replayed: true` → **"ya estaba asignada"**.
   - `writes_disabled` / `forbidden` / `actor_unavailable` → la clave es de
     solo lectura; explicalo y frená.

Si la orden no está pendiente o no hay orden de instalación para ese abonado,
decilo; no inventes un id.
