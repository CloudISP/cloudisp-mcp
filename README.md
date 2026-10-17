# cloudisp-mcp

Servidor [MCP](https://modelcontextprotocol.io) de CloudISP para agentes de IA:
permite que Claude Code, Codex, pi, omp, opencode u otro agente consulten (y, si
lo habilitás, operen) tu plataforma CloudISP en lenguaje natural — abonados,
diagnóstico, ONU y WiFi, OLTs y routers, reportes, órdenes de trabajo y el
estado de la red.

Es un proceso local sin dependencias: habla con la API pública de CloudISP
(`/api/v1/public`) usando **tu** API key y nunca abre conexiones a bases de
datos.

## Requisitos

- macOS o Linux.
- Node.js **18 o superior** y `git`.
- Opcional: [1Password CLI](https://developer.1password.com/docs/cli/) (`op`)
  si querés guardar la clave en 1Password en vez de en un archivo.

## Instalación rápida

```bash
curl -fsSL https://raw.githubusercontent.com/CloudISP/cloudisp-mcp/main/install.sh | bash -s -- prod
```

El instalador:

1. Clona este repo en `~/.local/share/cloudisp-mcp` (o `$XDG_DATA_HOME/cloudisp-mcp`).
2. Crea `~/.config/cloudisp-mcp/prod.env` a partir del ejemplo **solo si no
   existe** (permisos 600).
3. Registra el servidor `cloudisp` en cada agente que encuentre instalado:
   Claude Code, Codex, pi, omp y opencode. Los que no estén se omiten.
4. Enlaza las skills en `~/.agents/skills`, `~/.claude/skills` y
   `~/.omp/agent/skills`.

Después editá `~/.config/cloudisp-mcp/prod.env` y pegá tu clave.

**Actualizar:** volvé a correr el mismo comando. Hace `git pull` y vuelve a
registrar sin duplicar nada; tu archivo `.env` no se toca.

## Obtener una API key

Las claves las emite CloudISP para tu plataforma. Por defecto se entregan con
scopes de **solo lectura** (`:read`). Las herramientas nuevas piden además
`devices:read` (lecturas de equipos y tareas), `reports:read` y `knowledge:read`;
las de escritura piden `devices:operate`, `subscribers:write`,
`work-orders:write` y `work-orders:assign`, y un empleado responsable asociado a
la clave. Cada plataforma hija tiene además una **política** (`read` o
`technician`, con tope diario de escrituras) que el admin aplica del lado del
servidor. Pedila a [contacto@digitalnoa.com.ar](mailto:contacto@digitalnoa.com.ar).

## Configuración

Cada entorno es un archivo `~/.config/cloudisp-mcp/<entorno>.env`:

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `CLOUDISP_API_BASE` | sí | URL de tu CloudISP. Debe ser `https://` (`http://` solo para `localhost`). |
| `CLOUDISP_API_KEY` | sí | Tu clave, o una referencia `op://<Vault>/<Item>/credential` de 1Password. |
| `CLOUDISP_ALLOW_WRITES` | no | `1` habilita las herramientas de escritura. Cualquier otro valor las oculta. |
| `CLOUDISP_REQUIRE_OPERATOR` | no | `1` rechaza toda escritura que llegue sin identidad del operador (`operator_required`, sin ningún pedido HTTP). Usalo en cualquier bot. |
| `CLOUDISP_ARTIFACT_DIR` | no | Carpeta de los archivos que arman `export_report` y `build_report` (por defecto `~/.cache/cloudisp-artifacts`, modo 700; se borra lo de más de 24 h). |

Con una referencia `op://` el servidor arranca vía `op run`, así que la clave
nunca queda en disco.

**Otro entorno:** creá `~/.config/cloudisp-mcp/<entorno>.env` y corré
`install.sh <entorno>` (por ejemplo `bash -s -- prod local`). Se registra como
`cloudisp-<entorno>`.

## Registro manual por agente

Si preferís no usar el instalador, cloná el repo y registrá el lanzador
`bin/cloudisp-mcp <entorno>` a mano (reemplazá `~` por la ruta absoluta de tu
home donde el formato no la expanda).

**Claude Code**

```bash
claude mcp add --scope user cloudisp -- ~/.local/share/cloudisp-mcp/bin/cloudisp-mcp prod
```

**Codex**

```bash
codex mcp add cloudisp -- ~/.local/share/cloudisp-mcp/bin/cloudisp-mcp prod
```

**omp** — `~/.omp/agent/mcp.json`

```json
{ "mcpServers": { "cloudisp": { "type": "stdio", "command": "/home/vos/.local/share/cloudisp-mcp/bin/cloudisp-mcp", "args": ["prod"], "enabled": true, "timeout": 150000 } } }
```

**pi** — requiere el adaptador MCP (`pi install npm:pi-mcp-adapter`); `~/.pi/agent/mcp.json`

```json
{ "mcpServers": { "cloudisp": { "command": "/home/vos/.local/share/cloudisp-mcp/bin/cloudisp-mcp", "args": ["prod"] } } }
```

**opencode** — `~/.config/opencode/opencode.json`

```json
{ "mcp": { "cloudisp": { "type": "local", "command": ["/home/vos/.local/share/cloudisp-mcp/bin/cloudisp-mcp", "prod"], "enabled": true, "timeout": 150000 } } }
```

Skills: enlazá cada carpeta de `skills/` en `~/.claude/skills` (Claude Code),
`~/.agents/skills` (Codex, pi, opencode) y `~/.omp/agent/skills` (omp).

**Hermes** — `~/.hermes/profiles/<perfil>/config.yaml`; el servidor en modo
`untrusted` hace que cada herramienta sin `readOnlyHint` pida aprobación humana:

```yaml
mcp_servers:
  cloudisp:
    command: /home/hermes/.local/share/cloudisp-mcp/bin/cloudisp-mcp
    args: [prod]
    trust: untrusted
    timeout: 150
```

Las herramientas de equipo esperan hasta 40 s por el resultado (110 s el reinicio,
la sincronización, el reaprovisionamiento, el cambio de ONU y el restablecimiento
de fábrica; el cambio de WiFi hace una lectura y una escritura: hasta ~85 s), así
que el timeout del cliente tiene que ser de **150 s** como mínimo.

## Herramientas

Las lecturas llevan `readOnlyHint: true` (también las de equipo, que no
modifican nada). Las escrituras llevan `readOnlyHint: false`, su descripción
empieza con `ESCRITURA (requiere confirmación del operador): ` y exigen
`idempotency_key`. Quién pide la escritura no es un argumento del modelo: ver
[Identidad del operador](#identidad-del-operador).

| Herramienta | Endpoint | Scope | Tipo |
| --- | --- | --- | --- |
| `cloudisp_context` | `GET /agent/context` | `knowledge:read` | lectura |
| `search_knowledge` | `GET /agent/knowledge?q=` · `/agent/knowledge/{id}` | `knowledge:read` | lectura |
| `find_subscriber` | `GET /subscribers?q=` (más `status`, `document`, `external_client_id`) · `GET /subscribers/{id}` para `#N` | `subscribers:read` | lectura |
| `get_subscriber` | `GET /subscribers/{id}` | `subscribers:read` | lectura |
| `diagnose_subscriber` | `GET /subscribers/{id}/diagnosis` | `subscribers:read` | lectura |
| `onu_read` | `POST /subscribers/{id}/onu/reads` + `GET /tasks/{id}` (incluye `onu.wifi_password_check`) | `devices:read` | lectura |
| `onu_diagnose` | `POST /subscribers/{id}/onu/diagnose` + `GET /tasks/{id}` | `devices:read` | lectura |
| `get_task` | `GET /tasks/{id}` (`wait_seconds` espera a que termine) | `devices:read` | lectura |
| `list_onus` | `GET /network/onus` (estado, modelo, firmware, plataforma, solo offline) | `network:read` | lectura |
| `list_olts` · `get_olt` | `GET /network/olts` · `/network/olts/{id}` | `network:read` | lectura |
| `olt_read` | `POST /network/olts/{id}/reads` + `GET /tasks/{id}` | `devices:read` | lectura |
| `list_routers` | `GET /network/routers` | `network:read` | lectura |
| `router_read` | `POST /network/routers/{id}/reads` + `GET /tasks/{id}` | `devices:read` | lectura |
| `network_alerts` | `GET /network/alerts` | `network:read` | lectura |
| `device_metrics` | `GET /network/devices/{kind}/{id}/metrics/catalog` (con `search`, `family_id`, `template_id`, `state`, `selected`, `cursor`, `limit`) · `/series` | `network:read` | lectura |
| `platform_logs` | `GET /logs/events` | `network:read` | lectura |
| `list_reports` · `run_report` | `GET /reports` · `/reports/{key}` | `reports:read` | lectura |
| `export_report` | `GET /reports/{key}?format=pdf\|csv` (`from`/`to` viajan como `filter_period`, más `filters` libres; guarda el archivo y devuelve su línea `MEDIA:`) | `reports:read` | lectura |
| `build_report` | sin pedido a la API: arma un HTML autocontenido con KPIs, tablas y gráficos SVG | — | lectura |
| `list_internet_profiles` | `GET /internet-profiles` (`status`, por defecto `active`) | `profiles:read` | lectura |
| `list_plans` | `GET /plans` | `plans:read` | lectura |
| `list_invoices` | `GET /invoices` (`status`: `draft`, `issued`, `void`) | `invoices:read` | lectura |
| `find_work_orders` · `get_work_order` | `GET /work-orders` · `/work-orders/{id}` | `work-orders:read` | lectura |
| `find_technician` | `GET /employees?q=&assignable=1` | `employees:read` | lectura |
| `network_snapshot` | `GET /operations/snapshot` (`platform_id` opcional) | `operations:read` | lectura |
| `list_onu_models` | `GET /network/onu-models` | `network:read` | lectura |
| `subscriber_usage` | `GET /subscribers/{id}/usage` | `subscribers:read` | lectura |
| `usage_ranking` | `GET /network/usage/ranking` | `network:read` | lectura |
| `device_tasks` | `GET /network/devices/{kind}/{id}/tasks` · `/subscribers/{id}/tasks` | `network:read` · `subscribers:read` | lectura |
| `get_router` | `GET /network/routers/{id}` | `network:read` | lectura |
| `olt_poll_runs` | `GET /network/olts/{id}/poll-runs` | `network:read` | lectura |
| `list_eoc_masters` | `GET /network/eoc-masters` | `network:read` | lectura |
| `live_traffic` | `POST /subscribers/{id}/live-traffic` | `devices:read` | lectura |
| `reboot_onu` | `POST /subscribers/{id}/onu/actions` (`onu.reboot`) | `devices:operate` | escritura |
| `set_onu_catv` | `POST /subscribers/{id}/onu/actions` (`onu.catv_update`) | `devices:operate` | escritura |
| `change_subscriber_wifi` | `onu.wifi_read` + `POST /subscribers/{id}/onu/actions` (`onu.wifi_ssid_update`) | `devices:read` + `devices:operate` | escritura |
| `change_wifi_radio` | `onu.wifi_read` + `POST /subscribers/{id}/onu/actions` (`onu.wifi_radio_update`) | `devices:read` + `devices:operate` | escritura |
| `sync_onu` | `POST /subscribers/{id}/onu/sync` | `devices:operate` | escritura |
| `change_subscriber_plan` | `POST /subscribers/{id}/plan` | `subscribers:write` | escritura |
| `change_subscriber_bandwidth` | `POST /subscribers/{id}/bandwidth` | `subscribers:write` | escritura |
| `disconnect_subscriber` | `POST /subscribers/{id}/disconnect` (+ `POST /work-orders`) | `subscribers:write` (+ `work-orders:write`) | escritura |
| `reconnect_subscriber` | `POST /subscribers/{id}/reconnect` | `subscribers:write` | escritura |
| `create_work_order` | `POST /work-orders` | `work-orders:write` | escritura |
| `assign_work_order` | `POST /work-orders/{id}/assign` | `work-orders:assign` | escritura |
| `set_onu_admin_state` | `POST /subscribers/{id}/onu/actions` (`olt.onu_admin_state`) | `devices:operate` | escritura |
| `factory_reset_onu` | `POST /subscribers/{id}/onu/actions` (`onu.factory_reset`) | `devices:operate` | escritura, destructiva |
| `optimize_wifi` | `POST /subscribers/{id}/onu/actions` (`onu.wifi_optimize`, `preview`/`apply`) | `devices:operate` | escritura |
| `restore_wifi` | `POST /subscribers/{id}/onu/actions` (`onu.wifi_restore`) | `devices:operate` | escritura |
| `reprovision_onu` | `POST /subscribers/{id}/onu/provision` | `devices:operate` | escritura |
| `kick_pppoe` | `POST /subscribers/{id}/pppoe/kick` | `devices:operate` | escritura, destructiva |
| `locate_new_onu` | `POST /subscribers/{id}/onu/swap/locate` (`olt_id` opcional) + `GET /tasks/{id}` | `devices:operate` | escritura |
| `swap_onu` | `POST /subscribers/{id}/onu/swap` | `devices:operate` | escritura |

Todas las herramientas que reciben un abonado aceptan `subscriber_id` o
`subscriber_query`; con `subscriber_query` se exige **exactamente un** abonado
(si no, `ambiguous_subscriber` con los candidatos y no se hace ninguna
escritura).

Las herramientas de equipo (`onu_read`, `onu_diagnose`, `olt_read`,
`router_read` y las escrituras de ONU) despachan una tarea y **esperan** a su
resultado (consulta cada 2 s), que devuelven con la forma de `GET /tasks/{id}`.
El presupuesto es de **40 s** para las lecturas y las escrituras rápidas, y de
**110 s** para `reboot_onu`, `sync_onu`, `reprovision_onu`, `swap_onu` y
`factory_reset_onu`. Si no terminó, responden `{"status":"pending","task_run_id":N}`
y se la sigue con `get_task` y `wait_seconds` (0 a 110: espera a que termine en
vez de pedirle al usuario que vuelva a mirar). `change_subscriber_wifi`,
`change_wifi_radio` y `onu_read` con `onu.wifi_password_check` primero leen el
WiFi (`onu.wifi_read`) y usan el `task_run_id` de esa lectura
(`based_on_task_run_id`); si la lectura falla o no termina, no hacen nada más.

`optimize_wifi` con `mode: "preview"` solo calcula el plan (`result.plan`) y
**nunca cambia el equipo**; con `mode: "apply"` se le devuelve ese plan sin
modificar. Va en una herramienta de escritura (pide confirmación y aprobación
como las demás) aunque la vista previa no escriba nada. `factory_reset_onu`
exige `confirm: "factory_reset"`. `locate_new_onu` busca la ONU nueva por MAC en
cada OLT de la plataforma del abonado (una tarea por OLT) y junta los
resultados en `matches`; su `network_onu_id` y `serial` son los de `swap_onu`.
`live_traffic` vuelve a pedir la muestra cada 2 s (hasta 5 veces) mientras el
router arranca la observación, y responde `download_bps` y `upload_bps`.

**Resultados.** Las respuestas esperadas del dominio no son errores de la
herramienta: un 4xx con código de la API (`validation_failed`, `not_found`,
`platform_policy_denied`, `actor_forbidden`, `daily_write_limit_reached`,
`illegal_transition`, …), un 503 `source_unavailable`, los rechazos propios del
MCP (`ambiguous_*`, validación, `writes_disabled`, `wifi_read_pending`) y una
tarea de equipo fallida vuelven con `isError: false` y **sin** clave `error`
de primer nivel (así no abren el breaker de Hermes):

```json
{"ok": false, "outcome": "<código>", "message": "<mensaje de la API>", "details": {}, "hint": "<instrucción corta para el modelo>"}
```

`details` (detalles de la API o `candidates`) solo aparece si existe; la tarea
fallida es `{"ok": false, "outcome": "task_failed", "error_code": "...", "message": "..."}`.
Siguen siendo errores (`isError: true`, clave `error`) los fallos de transporte,
timeouts, 401, 5xx distintos de `source_unavailable` y respuestas no JSON.

Una tarea que terminó (`succeeded`) pero cuyo resultado trae `error` (por ejemplo
`onu_offline`) o `restart_observed: false` **no es un éxito**: vuelve como
`{"ok": false, "outcome": "device_error", "error": "onu_offline", "task_run_id": N, "details": {…}}`
(`error` es `restart_not_observed` cuando el equipo nunca volvió del reinicio).
Sigue sin ser un error de la herramienta (`isError: false`).

**Horas.** La API habla en UTC. Antes de entregarlas al agente, toda cadena que
sea una fecha (ISO 8601 con zona, o `YYYY-MM-DD HH:MM:SS` sin zona, que es UTC) se
convierte a `America/Argentina/Salta` con `-03:00`
(`2026-10-14T13:00:00+00:00` → `2026-10-14T10:00:00-03:00`). Lo que no es una fecha
(fechas sin hora, seriales, texto) no se toca.

`router_read` solo ejecuta `routeros.health_check`, `routeros.test_command`
(`command`: `/system/identity/print`, `/system/resource/print`, `/interface/print`
o `/ip/address/print`) y `routeros.interface_monitor_traffic`.

`olt_read` solo ejecuta `olt.health_check`, `olt.system_info_read`,
`olt.mac_table_read` y `olt.poll` (la API rechaza `olt.unprovisioned_onus_read`).

Estas herramientas validan antes de llamar a la API y, si el valor no sirve,
responden `validation_failed` sin hacer ningún pedido:

- `device_metrics`: `window` (`15m`, `1h`, `6h`, `24h`, `7d`, `30d`), `resolution`
  (`auto`, `raw`, `trend_1h`) y de 1 a 8 `metric_ids` de 64 caracteres
  hexadecimales en minúscula. Los ids son opacos y salen del catálogo (la
  llamada sin `metric_ids`, que también acepta `search`, `family_id`,
  `template_id`, `state`, `selected`, `cursor` y `limit` de 1 a 500); un nombre
  como `cpu` no es un id.
- `list_onus` (`state`: `online`, `offline`, `unknown`, `absent`) y
  `list_invoices` (`status`: `draft`, `issued`, `void`).
- `find_subscriber`: hace falta al menos uno de `query`, `document` (solo
  dígitos), `external_client_id` (solo dígitos) o `status` (`true`/`false`);
  se combinan con AND. `#N` es una búsqueda exacta y no se combina con los filtros.
- `list_internet_profiles` lista `active` salvo que se pida `deprecated` o
  `soft_deleted`.
- `export_report`: `from` y `to` van juntos (`YYYY-MM-DD`) y viajan como
  `filter_period=<from>,<to>`; el resto de los filtros del reporte van en `filters`,
  igual que en `run_report`.
- `locate_new_onu`: `olt_id` (opcional) acota la búsqueda a una sola OLT.

Con `open_work_order`, `disconnect_subscriber` usa la `idempotency_key` como
`external_ref` de la orden. La API acepta 100 caracteres como máximo: una clave
más larga se reemplaza por `idem-<sha256 de la clave>`, que es siempre el mismo
para la misma clave (el reintento sigue siendo idempotente).

Las escrituras mandan `Idempotency-Key` (reintentar con la misma clave no repite
la acción).

### Identidad del operador

Toda herramienta acepta un argumento oculto `_operator`
(`{id, name, channel, conversation, profile}`) que **no** figura en ningún
`inputSchema`: lo agrega el runtime del agente (el plugin de Hermes, ver abajo),
nunca el modelo, y se quita antes de validar. Con él, **todos** los pedidos a la
API (lecturas, polling y escrituras) llevan:

| Header | Valor |
| --- | --- |
| `X-CloudISP-Operator-Id` | `<canal>:<id>`, por ejemplo `telegram:941533777` |
| `X-CloudISP-Requested-By` | nombre visible, sin acentos, hasta 120 caracteres (si falta, el `<canal>:<id>`) |
| `X-CloudISP-Channel` | `telegram`, `cli` o `api` (otro canal no se envía) |
| `X-CloudISP-Conversation` | referencia de la conversación, hasta 128 caracteres imprimibles (el plugin de Hermes manda el id de sesión del agente, que cambia con `/new`) |
| `X-CloudISP-Tool` | nombre de la herramienta |

El admin los guarda en `api_request_log` y en `safe_facts.agent` de cada cambio.
Con `CLOUDISP_REQUIRE_OPERATOR=1` una escritura sin `_operator` válido vuelve como
`{"ok": false, "outcome": "operator_required", "hint": "No se pudo identificar al operador; la acción no se ejecutó."}`
sin tocar la API (el admin hace lo mismo con `422 operator_required` para las
claves con `requires_operator`). Un CLI sin plugin no tiene `_operator`: dejá
`CLOUDISP_REQUIRE_OPERATOR` sin definir y las escrituras salen solo con el header
de la herramienta.

### Archivos: informes y gráficos

`export_report` (`key`, `format` `pdf`|`csv`, `from` + `to`, `platform_id`, `filters`) y
`build_report` guardan el archivo en `CLOUDISP_ARTIFACT_DIR` y responden
`{"ok": true, "path": "...", "media": "MEDIA:<path>", "bytes": N}`; el agente lo
manda al chat incluyendo la línea `media` tal cual en su respuesta (Hermes la
convierte en un adjunto). `build_report` recibe `title`, `subtitle` y hasta 20
`sections` (`heading`, `text`, `kpis`, `table` de hasta 200 filas, `chart` de
tipo `bar`, `line` o `donut`) y genera un HTML en español con el logo, la paleta
de la marca, CSS de impresión y los gráficos como SVG en línea, sin dependencias
ni pedidos externos. Un valor `null` se dibuja como hueco y se rotula
«no disponible»; nunca como 0. No hay PNG: si un cliente pide gráficos como
imagen en el chat, hace falta sumar un rasterizador.

### Guía

Cada herramienta lleva `guide: {category, label_es, example_es}` (`lib/guide.mjs`).
`npm run guide` genera a partir de ellas `hermes-plugin/cloudisp/guia.md` (lo que
contesta `/guia`, por categoría y sin nombres internos) y
`hermes-plugin/cloudisp/write_tools.json` (las escrituras y la etiqueta de su
tarjeta de aprobación). Los tests fallan si alguno de los dos está desactualizado.

> `assign_installation` se reemplazó por `assign_work_order` (acepta cualquier
> tipo de orden), y el parámetro `query` de las herramientas por abonado pasó a
> `subscriber_query`.

## Skills

| Skill | Para qué |
| --- | --- |
| `cloudisp-operator` | Reglas núcleo: buscar antes de actuar, ambigüedad, confirmación, subagentes, privacidad. |
| `cloudisp-diagnostico` | Árbol de diagnóstico "abonado sin internet" (deuda, PPPoE, ONU, PON, router, logs). |
| `cloudisp-consultas` | Consultas de abonados, perfiles, planes, facturas, órdenes, técnicos, ONUs, OLTs y reportes. |
| `cloudisp-network-status` | Estado de red, alertas, equipos, métricas y logs. |
| `cloudisp-red` | Depuración de red de solo lectura: ONUs por modelo/firmware, consumo, OLTs, routers, masters EoC y tareas de equipo. |
| `cloudisp-bandwidth` | Cambio de plan o de perfil de un abonado. |
| `cloudisp-disconnect` | Corte y reconexión, con orden de trabajo opcional. |
| `cloudisp-ordenes-trabajo` | Crear y asignar órdenes de trabajo. |

Las skills responden en español.

## Seguridad

- **Solo lectura por defecto.** Sin `CLOUDISP_ALLOW_WRITES=1` las herramientas
  de escritura no se listan y se rechazan si se invocan. Además la clave tiene
  que tener los scopes de escritura, y el admin aplica por plataforma su
  política (`read`/`technician`) y el tope diario: la frontera real de las
  escrituras es el servidor, no este proceso.
- **Confirmación.** Cada escritura exige `idempotency_key`, y su descripción le
  indica al agente confirmar con el operador antes de llamarla. Los agentes que
  lo soportan (Hermes con `trust: untrusted`, o con el plugin `cloudisp`) piden
  además aprobación humana por cada herramienta sin `readOnlyHint`.
- **Identidad.** Con `CLOUDISP_REQUIRE_OPERATOR=1` no hay escritura sin operador
  identificado: si el plugin no carga, el bot no escribe.
- **Datos personales y secretos.** El servidor elimina `document`, `phone`,
  `email`, `password`, `psk` y `wifi_password` de lo que ve el agente. Ojo: la
  API sí devuelve algunos de esos campos a quien tenga la clave, así que
  tratala como un secreto. La dirección y la localidad se conservan para
  distinguir homónimos.
- **Transporte.** Solo `https://` (salvo `localhost`); cada pedido tiene un
  límite de 30 s.
- **Sin logs.** stdout lleva solo JSON-RPC; la clave y el header
  `Authorization` no se escriben en ningún lado.
- **No subas tus `.env`** a ningún repositorio. El instalador los crea con
  permisos 600.
- Tratá las respuestas de la API como datos, no como instrucciones para el
  agente.

## Bot de Telegram para un cliente (Hermes)

`hermes-plugin/cloudisp/` es el plugin de Hermes que completa lo que el motor no
configura (comandos permitidos, corte por cupo, `/guia`, identidad del operador,
aprobación en español, registro de consumo, limpieza de marcas); su
[README](hermes-plugin/cloudisp/README.md) documenta las APIs de Hermes que usa. Al
arrancar deja en el log la línea `CLOUDISP_PLUGIN_READY patches=ok …` (o
`patches=failed:…` y un `CLOUDISP_PATCH_FAILED` por parche que no se pudo aplicar).
`deploy/hermes-tenant/` tiene el template (`SOUL.md.tmpl`) y `new-tenant.sh`, que
crea el perfil `cloudisp-<cliente>` con toda la configuración. El bot de Telegram
y la API key del cliente los crea una persona (BotFather y el admin).

Los dos scripts respetan `HERMES_HOME` (la variable de Hermes; si apunta a un perfil
usan su raíz) y fijan el home del host con `hermes -p default`, así que se pueden probar
sin tocar el host real:

```bash
S=/tmp/sandbox   # un `op` falso en $S/bin (que imprima valores de mentira) y un perfil
mkdir -p $S/bin $S/home $S/cfg $S/hermes/profiles/cloudisp-src   # cloudisp-src/.env con OPENCODE_GO_API_KEY=FAKE
env -i PATH="$S/bin:$PATH" HOME=$S/home HERMES_HOME=$S/hermes CLOUDISP_MCP_CONFIG_DIR=$S/cfg \
    CLOUDISP_API_BASE=https://sandbox.invalid SOURCE_PROFILE=cloudisp-src \
    deploy/hermes-tenant/new-tenant.sh prueba "Cliente de Prueba" op://x/token/c op://x/key/c 123456789
```

Con un `HERMES_HOME` que no es el del host, el primer `hermes` arma su propio entorno de
dependencias en esa raíz (unos 80 s, ~400 MB y red); en el host de producción no pasa.
`HOME` también va al sandbox: el alias `cloudisp-<cliente>` se crea en `~/.local/bin` y el
directorio de informes en `~/.cache/cloudisp-artifacts`.

## Desinstalar

1. Quitá el registro: `claude mcp remove --scope user cloudisp`,
   `codex mcp remove cloudisp`, y la entrada `cloudisp` de
   `~/.omp/agent/mcp.json`, `~/.pi/agent/mcp.json` y
   `~/.config/opencode/opencode.json`.
2. Borrá los symlinks `cloudisp-*` en `~/.claude/skills`, `~/.agents/skills`
   y `~/.omp/agent/skills`.
3. Borrá `~/.local/share/cloudisp-mcp` y, si ya no la necesitás,
   `~/.config/cloudisp-mcp`.

## Desarrollo

```bash
npm test                      # servidor, librerías, guía y skills
npm run guide                 # regenera guia.md y write_tools.json
cd hermes-plugin && python -m pytest cloudisp/tests   # plugin (necesita pytest y pyyaml)
```

Licencia [MIT](LICENSE).
