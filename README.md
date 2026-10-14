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
{ "mcpServers": { "cloudisp": { "type": "stdio", "command": "/home/vos/.local/share/cloudisp-mcp/bin/cloudisp-mcp", "args": ["prod"], "enabled": true, "timeout": 120000 } } }
```

**pi** — requiere el adaptador MCP (`pi install npm:pi-mcp-adapter`); `~/.pi/agent/mcp.json`

```json
{ "mcpServers": { "cloudisp": { "command": "/home/vos/.local/share/cloudisp-mcp/bin/cloudisp-mcp", "args": ["prod"] } } }
```

**opencode** — `~/.config/opencode/opencode.json`

```json
{ "mcp": { "cloudisp": { "type": "local", "command": ["/home/vos/.local/share/cloudisp-mcp/bin/cloudisp-mcp", "prod"], "enabled": true, "timeout": 120000 } } }
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
    timeout: 120
```

Las herramientas de equipo esperan hasta 40 s por el resultado (el cambio de
WiFi hace una lectura y una escritura: hasta ~85 s), así que el timeout del
cliente tiene que ser de **120 s** como mínimo.

## Herramientas

Las lecturas llevan `readOnlyHint: true` (también las de equipo, que no
modifican nada). Las escrituras llevan `readOnlyHint: false`, su descripción
empieza con `ESCRITURA (requiere confirmación del operador): ` y exigen
`requested_by` e `idempotency_key`.

| Herramienta | Endpoint | Scope | Tipo |
| --- | --- | --- | --- |
| `cloudisp_context` | `GET /agent/context` | `knowledge:read` | lectura |
| `search_knowledge` | `GET /agent/knowledge?q=` · `/agent/knowledge/{id}` | `knowledge:read` | lectura |
| `find_subscriber` | `GET /subscribers?q=` | `subscribers:read` | lectura |
| `get_subscriber` | `GET /subscribers/{id}` | `subscribers:read` | lectura |
| `diagnose_subscriber` | `GET /subscribers/{id}/diagnosis` | `subscribers:read` | lectura |
| `onu_read` | `POST /subscribers/{id}/onu/reads` + `GET /tasks/{id}` | `devices:read` | lectura |
| `onu_diagnose` | `POST /subscribers/{id}/onu/diagnose` + `GET /tasks/{id}` | `devices:read` | lectura |
| `get_task` | `GET /tasks/{id}` | `devices:read` | lectura |
| `list_onus` | `GET /network/onus` | `network:read` | lectura |
| `list_olts` · `get_olt` | `GET /network/olts` · `/network/olts/{id}` | `network:read` | lectura |
| `olt_read` | `POST /network/olts/{id}/reads` + `GET /tasks/{id}` | `devices:read` | lectura |
| `list_routers` | `GET /network/routers` | `network:read` | lectura |
| `router_read` | `POST /network/routers/{id}/reads` + `GET /tasks/{id}` | `devices:read` | lectura |
| `network_alerts` | `GET /network/alerts` | `network:read` | lectura |
| `device_metrics` | `GET /network/devices/{kind}/{id}/metrics/catalog` · `/series` | `network:read` | lectura |
| `platform_logs` | `GET /logs/events` | `network:read` | lectura |
| `list_reports` · `run_report` | `GET /reports` · `/reports/{key}` | `reports:read` | lectura |
| `list_internet_profiles` | `GET /internet-profiles` | `profiles:read` | lectura |
| `list_plans` | `GET /plans` | `plans:read` | lectura |
| `list_invoices` | `GET /invoices` | `invoices:read` | lectura |
| `find_work_orders` · `get_work_order` | `GET /work-orders` · `/work-orders/{id}` | `work-orders:read` | lectura |
| `find_technician` | `GET /employees?q=` | `employees:read` | lectura |
| `network_snapshot` | `GET /operations/snapshot` | `operations:read` | lectura |
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

Todas las herramientas que reciben un abonado aceptan `subscriber_id` o
`subscriber_query`; con `subscriber_query` se exige **exactamente un** abonado
(si no, `ambiguous_subscriber` con los candidatos y no se hace ninguna
escritura).

Las herramientas de equipo (`onu_read`, `onu_diagnose`, `olt_read`,
`router_read` y las escrituras de ONU) despachan una tarea y **esperan hasta
40 s** (consulta cada 2 s) a su resultado, que devuelven con la forma de
`GET /tasks/{id}`. Si no terminó, responden `{"status":"pending","task_run_id":N}`
y se la sigue con `get_task`. `change_subscriber_wifi` y `change_wifi_radio`
primero leen el WiFi (`onu.wifi_read`) y escriben con el `task_run_id` de esa
lectura (`based_on_task_run_id`); si la lectura falla o no termina, no escriben.

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

`router_read` solo ejecuta `routeros.health_check`, `routeros.test_command`
(`command`: `/system/identity/print`, `/system/resource/print`, `/interface/print`
o `/ip/address/print`) y `routeros.interface_monitor_traffic`.

Las escrituras mandan `Idempotency-Key` (reintentar con la misma clave no repite
la acción) y `X-CloudISP-Requested-By` (quién lo pidió; el admin lo registra y lo
antepone a la auditoría). Cuando `requested_by` tiene acentos se envía sin ellos.

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
- **Confirmación.** Cada escritura exige `requested_by` e `idempotency_key`, y
  su descripción le indica al agente confirmar con el operador antes de
  llamarla. Los agentes que lo soportan (Hermes con `trust: untrusted`) piden
  además aprobación humana por cada herramienta sin `readOnlyHint`.
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
npm test
```

Licencia [MIT](LICENSE).
