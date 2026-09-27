---
name: cloudisp-consultas
description: "Consultas de solo lectura en CloudISP con el servidor MCP cloudisp: buscar o consultar abonados, perfiles de internet, órdenes de trabajo y técnicos. Usala cuando pidan buscar/consultar un abonado, ver perfiles o planes, listar órdenes o encontrar un técnico (find subscriber, list profiles, work orders, technician lookup)."
license: MIT
compatibility: Requiere el servidor MCP cloudisp (https://github.com/CloudISP/cloudisp-mcp).
---

# Consultas CloudISP (solo lectura)

Respondé en **español**. Aplicá las reglas de `cloudisp-operator`. Estas
herramientas no modifican nada: no hace falta confirmación.

## Abonados — `find_subscriber`

- Buscá con `query` (nombre, apellido, fragmento de documento o dirección; mínimo
  2 caracteres). Leé `meta.total` para saber cuántos coinciden.
- Si hay varios, listá `id — nombre` y, para distinguir homónimos, la dirección
  o localidad. Preguntá cuál antes de seguir.
- Nunca muestres documento, teléfono ni email.

## Perfiles — `list_internet_profiles`

- Sin argumentos. Informá `id`, nombre, `download_max_limit` y
  `upload_max_limit` tal como vienen (Mbps).
- Si piden "cuántos perfiles", contá los elementos de `data`.

## Órdenes de trabajo — `find_work_orders`

- Filtrá por `client_id` (preferido, obtenido de `find_subscriber`) o por
  `query` del abonado, más `type` y `status` opcionales.
- Si el `query` coincide con varios abonados, la herramienta devuelve los
  candidatos y no lista órdenes: preguntá cuál.
- Informá `id`, tipo, estado y técnico asignado si viene.

## Técnicos — `find_technician`

- Buscá por fragmento de nombre. Devolvé `employee_id` y nombre.
- Sin resultados: decí que no hay un técnico activo con ese nombre; no inventes.

## Formato de respuesta

- Respuestas cortas, con los ids para que el operador pueda seguir.
- Lo que no vino en la respuesta es **"no disponible"**.
