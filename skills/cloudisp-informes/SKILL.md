---
name: cloudisp-informes
description: "Armar informes en PDF con el servidor MCP cloudisp, con la marca de la plataforma (portada, gráficos y detalle): Reporte de ventas (altas del período, clientes únicos, instaladas, bajas, base, neto, altas por día, por localidad, por plan y por vendedor, detalle de cada alta, órdenes abiertas y red al cierre) y Estado de órdenes de trabajo (por estado, donut y OTs abiertas por días). Usala para 'reporte de ventas', 'ventas de noviembre', 'altas del mes', 'cuántas altas hubo', 'estado de las OT', 'órdenes abiertas', 'informe PDF', 'sales report' o 'work order status report'."
license: MIT
compatibility: Requiere el servidor MCP cloudisp (https://github.com/CloudISP/cloudisp-mcp) y, para el PDF, Chromium en el equipo del bot.
---

# Informes en PDF

Respondé en **español**. Todo esto es **lectura**: no pide confirmación. Aplicá las
reglas de `cloudisp-operator` (llamá `cloudisp_context` primero; dato faltante =
**"no disponible"**, nunca `0`).

## Cómo salen los informes

- `build_report` arma el informe con los datos que **ya leíste** y lo entrega como
  **PDF** (`format` es `pdf` por defecto; `html` solo si lo piden). Incluí la línea
  `media` que devuelve, tal cual, en tu respuesta: así llega como adjunto.
- La **marca** la decide la plataforma de la credencial: el bot de un cliente de
  NextScale entrega portada azul con el logo, "Preparado para <cliente>", pie
  "Documento confidencial · Preparado por NextScale" y número de página; los demás,
  el estilo de CloudISP. No tenés que elegirla ni mencionarla.
- Si la respuesta trae `pdf_unavailable: true`, el equipo no pudo imprimir el PDF y
  el archivo es el HTML: avisalo en una línea.
- `build_report` toma `kind` (el tipo de informe, arriba de la portada: "Reporte de
  ventas"), `title` (el título grande: el mes, "Noviembre 2026"), `period` (la línea
  del período: "Ventas del 1 al 19 de noviembre de 2026"; la hora de corte la agrega
  el sistema) y `sections`. Las secciones sin número reciben el suyo (01, 02…); si
  escribís "01 · …" se respeta. Hasta 20 secciones; cada tabla, hasta 200 filas.
- Pasá los datos **exactos** (nunca redondees a ojo ni inventes puntos), `null` donde
  falte, e identificadores como texto.

## Resolver el período

"Noviembre" → del `2026-11-01` al último día del mes (o hasta hoy si es el mes en
curso). "Del 1 al 19" → `2026-11-01` a `2026-11-19`. Se pasa a los reportes como
`filters.filter_period = "<desde>,<hasta>"` (fechas `YYYY-MM-DD`). Si el pedido no
dice período, preguntá. Todas las fechas y horas ya vienen en hora de Salta.

## Reporte de ventas

Una **alta** es un contrato que empezó en el período; los **cambios de plan** no
cuentan (se excluyen salvo `filter_include_migrations: 1`). El **vendedor** es quien
registró la OT de instalación más cercana en el tiempo para ese cliente ("Sin
vendedor" si no hay).

1. `run_report` con `key: "ventas"`, `detail: true` y
   `filters: { filter_period, filter_granularity: "day" }`. Trae `stats` (los
   totales: altas, clientes únicos, instaladas, bajas, neto, base), `data` (una fila
   por día: `period_label` y las métricas) y `detail` (`data` y `totalCount`: una
   fila por alta).
2. `run_report` otra vez con `filters.filter_group_by: "seller"`, y una tercera con
   `"plan"` (más una con `"platform"` para las localidades si el catálogo de
   `list_reports` la ofrece): sumá `altas` por `dim_label` entre todas las filas.
3. `run_report` con `key: "otestado"` y `filters: { filter_only_open: 1 }` para las
   órdenes abiertas, y `network_snapshot` para la red al cierre.
4. `build_report` con `kind: "Reporte de ventas"`, `title` con el mes, `period` con
   el rango y estas secciones:
   - **01 · Ventas del <dd/mm> al <dd/mm/aaaa>**: KPIs *Altas de contrato*, *Clientes
     únicos*, *Instaladas*, *Bajas*, *Base actual*, *Neto*.
   - **02 · Altas por día**: gráfico de barras (categorías `dd/mm`, una serie *Altas*).
   - **03 · Detalle por localidad**: tabla *Localidad · Altas · %* (el porcentaje es
     sobre el total de altas).
   - **04 · Altas por plan**: gráfico de barras, más un texto con el vendedor: "Mayor
     vendedor: <nombre> con N altas (X%)." (o "no disponible" sin datos de vendedor).
   - **05 · Detalle**: tabla con las filas de `detail` (ID, Cliente, Fecha, Plan,
     Localidad, OT, Estado OT, Técnico, Vendedor). Si `totalCount` supera las filas
     mostradas, escribí "Se muestran N de M altas" en el texto.
   - **06 · Órdenes abiertas**: KPIs *Pendientes*, *En progreso*, *Incompletas* de la
     corrida de `otestado` con `only_open`.
   - **07 · Red al cierre**: KPIs *Abonados online* y *Throughput WAN (Mbps)* de
     `network_snapshot`, con su hora de captura en el texto.
   - **Notas**: qué es una alta, que los cambios de plan están excluidos, cómo se
     define el vendedor y el corte (fecha y hora del informe). Un cliente con altas
     en dos días cuenta dos veces en la suma de *Clientes únicos* por día: aclaralo si
     difiere del total.

## Estado de OT

1. `run_report` con `key: "otestado"`, `detail: true` y
   `filters: { filter_period, filter_granularity: "month" }`: `stats` trae las OT
   creadas y las pendientes, en progreso, incompletas, completadas y canceladas.
2. `run_report` con `filters.filter_only_open: 1` y `detail: true`: las OT abiertas a
   la fecha (ignora el período), cada una con *Días abierta*.
3. `build_report` con `kind: "Estado de órdenes de trabajo"`, `title` con el período
   y estas secciones:
   - **KPIs por estado**: *Creadas*, *Pendientes*, *En progreso*, *Incompletas*,
     *Completadas*, *Canceladas*.
   - **Reparto por estado**: gráfico de anillo (`donut`), una serie con las cinco
     cantidades.
   - **OT abiertas**: tabla ordenada por *Días abierta* de mayor a menor (OT, Tipo,
     Cliente, Localidad, Estado, Días abierta, Técnico), y el aviso "Todas las OT
     abiertas a la fecha" porque ignoran el período.
   - **Notas**: el período y la fecha de corte.

## Si algo falla

- `run_report` con `source_unavailable` o sin datos: poné "no disponible" en esa
  sección y seguí con el resto; no armes el informe con datos inventados.
- Un reporte (`ventas`, `otestado`) que `list_reports` no muestra todavía: decí que
  esa plataforma aún no lo tiene y ofrecé el informe que sí exista.
