# cloudisp-mcp

Servidor [MCP](https://modelcontextprotocol.io) de CloudISP para agentes de IA:
permite que Claude Code, Codex, pi, omp u opencode consulten (y, si lo habilitás,
operen) tu plataforma CloudISP en lenguaje natural — buscar abonados, ver
perfiles, órdenes de trabajo, técnicos y el estado de la red.

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
scopes de **solo lectura** (`:read`). Los scopes de escritura requieren un
empleado responsable asociado a la clave. Pedila a
[contacto@digitalnoa.com.ar](mailto:contacto@digitalnoa.com.ar).

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
{ "mcpServers": { "cloudisp": { "type": "stdio", "command": "/home/vos/.local/share/cloudisp-mcp/bin/cloudisp-mcp", "args": ["prod"], "enabled": true, "timeout": 60000 } } }
```

**pi** — requiere el adaptador MCP (`pi install npm:pi-mcp-adapter`); `~/.pi/agent/mcp.json`

```json
{ "mcpServers": { "cloudisp": { "command": "/home/vos/.local/share/cloudisp-mcp/bin/cloudisp-mcp", "args": ["prod"] } } }
```

**opencode** — `~/.config/opencode/opencode.json`

```json
{ "mcp": { "cloudisp": { "type": "local", "command": ["/home/vos/.local/share/cloudisp-mcp/bin/cloudisp-mcp", "prod"], "enabled": true, "timeout": 60000 } } }
```

Skills: enlazá cada carpeta de `skills/` en `~/.claude/skills` (Claude Code),
`~/.agents/skills` (Codex, pi, opencode) y `~/.omp/agent/skills` (omp).

## Herramientas

| Herramienta | Scope | Tipo |
| --- | --- | --- |
| `find_subscriber` | `subscribers:read` | lectura |
| `list_internet_profiles` | `profiles:read` | lectura |
| `find_work_orders` | `work-orders:read` | lectura |
| `find_technician` | `employees:read` | lectura |
| `network_snapshot` | `operations:read` | lectura |
| `change_subscriber_bandwidth` | `subscribers:write` | escritura |
| `disconnect_subscriber` | `subscribers:write` (+ `work-orders:write`) | escritura |
| `assign_installation` | `work-orders:assign` | escritura |

Las herramientas de escritura usan `Idempotency-Key`: reintentar con la misma
clave no repite la acción.

## Skills

| Skill | Para qué |
| --- | --- |
| `cloudisp-operator` | Reglas base: buscar antes de actuar, ambigüedad, confirmación, privacidad. |
| `cloudisp-consultas` | Consultas de abonados, perfiles, órdenes y técnicos. |
| `cloudisp-network-status` | Abonados online y throughput WAN. |
| `cloudisp-bandwidth` | Cambio de perfil de un abonado. |
| `cloudisp-disconnect` | Desconexión con orden de trabajo opcional. |
| `cloudisp-assign-installation` | Asignar una instalación a un técnico. |

Las skills responden en español.

## Seguridad

- **Solo lectura por defecto.** Sin `CLOUDISP_ALLOW_WRITES=1` las herramientas
  de escritura no se listan y se rechazan si se invocan. Además la clave tiene
  que tener los scopes de escritura.
- **Datos personales.** El servidor elimina `document`, `phone` y `email` de
  lo que ve el agente. Ojo: la API sí devuelve esos campos a quien tenga la
  clave, así que tratala como un secreto. La dirección y la localidad se
  conservan para distinguir homónimos.
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
