---
name: cloudisp-bandwidth
description: "Cambiar el ancho de banda o perfil de internet de un abonado de CloudISP (subir/bajar megas, cambiar de plan) con el servidor MCP cloudisp. Usala para pedidos de change bandwidth, change profile o upgrade/downgrade plan."
license: MIT
compatibility: Requiere el servidor MCP cloudisp (https://github.com/CloudISP/cloudisp-mcp).
---

# Cambiar el perfil de un abonado

Respondé en **español**. Seguí el flujo en orden; no saltees la confirmación.

1. **Buscar el abonado** — `find_subscriber` con el nombre o documento que dio
   el operador. Ante `ambiguous_subscriber`, listá `id — nombre` y preguntá
   cuál. Nunca elijas vos.
2. **Listar perfiles** — `list_internet_profiles`. Buscá el destino pedido por
   `download_max_limit` (Mbps exactos) o por nombre. Si coinciden varios,
   mostralos (`id`, nombre, `download_max_limit`) y preguntá.
3. **Confirmar** — repetí `id` + nombre del abonado y el cambio de → a (Mbps).
   Esperá un "sí" explícito.
4. **Escribir** — `change_subscriber_bandwidth` con `subscriber_id` (o el
   `query` confirmado), `profile_id` (o `download_max_limit`) e
   `idempotency_key` = `agent-<yyyymmddhhmmss>-bandwidth-<subscriber_id>` con la
   hora local actual. Si reintentás, reusá la misma clave.
5. **Informar** —
   - `profile_ambiguous` → listá los candidatos y volvé a preguntar.
   - `provider_sync: "queued"` → **"aplicado en CloudISP, sincronización con
     RADIUS en curso"**. Nunca digas que el router o la sesión ya cambiaron.
   - `replayed: true` → el cambio ya se había aplicado con esa clave.
   - `writes_disabled` / `forbidden` / `actor_unavailable` → la clave es de
     solo lectura o no tiene empleado responsable; explicalo y frená.
