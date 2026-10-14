---
name: cloudisp-bandwidth
description: "Cambiar el plan, el ancho de banda o el perfil de internet de un abonado de CloudISP (subir/bajar megas, cambiar de plan) con el servidor MCP cloudisp. Usala para pedidos de change bandwidth, change profile, change plan o upgrade/downgrade plan."
license: MIT
compatibility: Requiere el servidor MCP cloudisp (https://github.com/CloudISP/cloudisp-mcp).
---

# Cambiar el plan o el perfil de un abonado

Respondé en **español**. Aplicá las reglas de `cloudisp-operator`. Seguí el flujo
en orden; no saltees la confirmación.

1. **Buscar el abonado** — `find_subscriber` con el nombre o documento que dio
   el operador. Ante `ambiguous_subscriber`, listá `id — nombre` y preguntá
   cuál. Nunca elijas vos.
2. **Elegir el destino**
   - **Plan comercial** (cambia lo que se factura y el perfil): `list_plans` y
     buscá el plan pedido. Escritura: `change_subscriber_plan` con `plan_id`.
   - **Solo el perfil de internet** (velocidad): `list_internet_profiles` y
     buscá el destino por `download_max_limit` (Mbps exactos) o por nombre.
     Escritura: `change_subscriber_bandwidth` con `profile_id` (o
     `download_max_limit`).
   - Si coinciden varios destinos, mostralos (`id`, nombre, Mbps) y preguntá.
     Si el operador dice "cambiale la velocidad" sin aclarar, preguntá si es plan
     o solo perfil.
3. **Confirmar** — resumen con `id` + nombre del abonado, plataforma y el
   cambio de → a (plan o Mbps), con los botones `✅ Confirmar` / `❌ Cancelar`.
4. **Escribir** — `subscriber_id` (o el `subscriber_query` confirmado),
   `requested_by` e `idempotency_key` =
   `agent-<yyyymmddhhmmss>-bandwidth-<subscriber_id>` con la hora local actual.
   Si reintentás, reusá la misma clave.
5. **Informar** —
   - `profile_ambiguous` → listá los candidatos y volvé a preguntar.
   - `provider_sync: "queued"` → **"aplicado en CloudISP, sincronización con
     RADIUS en curso"**. Nunca digas que el router o la sesión ya cambiaron.
   - `replayed: true` → el cambio ya se había aplicado con esa clave.
   - `plan_not_found`, `plan_without_profile`, `client_mutation_conflict`,
     `change_rejected` → informá el motivo de la API y frená.
   - `writes_disabled` / `platform_policy_denied` / `actor_forbidden` /
     `daily_write_limit_reached` → informalo y frená; no reintentes.
