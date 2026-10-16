#!/usr/bin/env bash
# Crea el perfil de Hermes y el entorno del MCP de UN cliente (un bot por cliente).
#
# Uso: new-tenant.sh <slug> "<Nombre del cliente>" <op://token-del-bot> <op://api-key> [id-de-telegram]
#
#   slug             minúsculas, números y guiones; el perfil queda como cloudisp-<slug>
#   op://token-del-bot  referencia 1Password del token que da BotFather
#   op://api-key     referencia 1Password de la API key del cliente (api_client en su plataforma padre)
#   id-de-telegram   opcional: usuario autorizado (y canal principal) del bot; si falta, se completa a mano
#
# Corre como el usuario `hermes` dentro del CT, con `op` autenticado. Los secretos se leen con
# `op read` y se escriben sólo en archivos de modo 600: nunca se imprimen ni pasan por argv.
# La configuración se aplica con `hermes -p <perfil> config set`; no se reescribe ningún YAML.
# El bot de Telegram y el api_client los crea una persona (BotFather y un master admin del admin).
#
# Variables opcionales: HERMES_HOME_DIR, CLOUDISP_MCP_HOME, CLOUDISP_MCP_CONFIG_DIR, CLOUDISP_API_BASE,
# SOURCE_PROFILE (perfil del que se copia OPENCODE_GO_API_KEY, por defecto cloudisp-nvs), BOT_NAME.
set -euo pipefail
umask 077

die() { echo "new-tenant: $*" >&2; exit 1; }

[ $# -ge 4 ] && [ $# -le 5 ] || die "uso: new-tenant.sh <slug> \"<Nombre del cliente>\" <op://token-del-bot> <op://api-key> [id-de-telegram]"
SLUG="$1"; TENANT="$2"; TOKEN_REF="$3"; KEY_REF="$4"; TG_USER="${5:-}"

[[ "$SLUG" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "slug inválido: minúsculas, números y guiones (2 a 31 caracteres)"
[[ -n "$TENANT" && "$TENANT" != *$'\n'* ]] || die "el nombre del cliente no puede estar vacío ni tener saltos de línea"
[[ "$TOKEN_REF" == op://* && "$KEY_REF" == op://* ]] || die "el token y la API key se pasan como referencias op://"
[[ -z "$TG_USER" || "$TG_USER" =~ ^[0-9]{3,15}$ ]] || die "el id de Telegram es numérico"

PROFILE="cloudisp-$SLUG"
HERMES_HOME_DIR="${HERMES_HOME_DIR:-$HOME/.hermes}"
MCP_HOME="${CLOUDISP_MCP_HOME:-$HOME/.local/share/cloudisp-mcp}"
CFG_DIR="${CLOUDISP_MCP_CONFIG_DIR:-$HOME/.config/cloudisp-mcp}"
API_BASE="${CLOUDISP_API_BASE:-https://admin.cloudisp.com.ar}"
SOURCE_PROFILE="${SOURCE_PROFILE:-cloudisp-nvs}"
BOT_NAME="${BOT_NAME:-Asistente CloudISP}"
PROFILE_DIR="$HERMES_HOME_DIR/profiles/$PROFILE"
ENV_FILE="$CFG_DIR/$SLUG.env"
TEMPLATE="$MCP_HOME/deploy/hermes-tenant/SOUL.md.tmpl"
ARTIFACT_DIR="$HOME/.cache/cloudisp-artifacts/$SLUG"

for tool in hermes op node; do command -v "$tool" >/dev/null || die "falta '$tool' en el PATH"; done
[ -x "$MCP_HOME/bin/cloudisp-mcp" ] && [ -r "$TEMPLATE" ] || die "no encuentro cloudisp-mcp en $MCP_HOME (¿checkout del tag?)"
[ -r "$MCP_HOME/hermes-plugin/cloudisp/plugin.yaml" ] || die "el checkout de $MCP_HOME no trae hermes-plugin/cloudisp"
[ ! -e "$PROFILE_DIR" ] || die "el perfil $PROFILE ya existe"
[ ! -e "$ENV_FILE" ] || die "$ENV_FILE ya existe"
SOURCE_ENV="$HERMES_HOME_DIR/profiles/$SOURCE_PROFILE/.env"
grep -q '^OPENCODE_GO_API_KEY=.' "$SOURCE_ENV" 2>/dev/null || die "no encuentro OPENCODE_GO_API_KEY en $SOURCE_ENV"

# Secretos: sólo en variables del script y en archivos 600.
BOT_TOKEN="$(op read "$TOKEN_REF")"; [ -n "$BOT_TOKEN" ] || die "op read del token del bot no devolvió nada"
API_KEY="$(op read "$KEY_REF")"; [ -n "$API_KEY" ] || die "op read de la API key no devolvió nada"
MODEL_KEY="$(grep '^OPENCODE_GO_API_KEY=' "$SOURCE_ENV" | head -n 1 | cut -d= -f2-)"

hermes profile create "$PROFILE" --no-skills --description "Asistente CloudISP $TENANT" >/dev/null

# Entorno del perfil (token del bot, clave del modelo, usuarios autorizados y canal principal).
{
    printf 'OPENCODE_GO_API_KEY=%s\n' "$MODEL_KEY"
    printf 'TELEGRAM_BOT_TOKEN=%s\n' "$BOT_TOKEN"
    printf 'TELEGRAM_ALLOWED_USERS=%s\n' "$TG_USER"
    # Con un canal principal el motor no manda su aviso de "sin canal principal" en cada sesión nueva.
    [ -z "$TG_USER" ] || printf 'TELEGRAM_HOME_CHANNEL=%s\n' "$TG_USER"
} >> "$PROFILE_DIR/.env"
chmod 600 "$PROFILE_DIR/.env"

# Entorno del MCP: lo lee bin/cloudisp-mcp (args [<slug>]) y el plugin (env_file).
mkdir -p "$CFG_DIR" "$ARTIFACT_DIR"
chmod 700 "$CFG_DIR" "$ARTIFACT_DIR"
{
    printf 'CLOUDISP_API_BASE=%s\n' "$API_BASE"
    printf 'CLOUDISP_API_KEY=%s\n' "$API_KEY"
    printf 'CLOUDISP_ALLOW_WRITES=1\n'
    printf 'CLOUDISP_REQUIRE_OPERATOR=1\n'
    printf 'CLOUDISP_ARTIFACT_DIR=%s\n' "$ARTIFACT_DIR"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
unset BOT_TOKEN API_KEY MODEL_KEY

# Identidad: el template genérico con el nombre del bot y del cliente (sin datos de red: esos van a la KB).
shopt -u patsub_replacement 2>/dev/null || true
SOUL="$(< "$TEMPLATE")"
SOUL="${SOUL//\{BOT_NAME\}/$BOT_NAME}"
SOUL="${SOUL//\{TENANT_NAME\}/$TENANT}"
printf '%s\n' "$SOUL" > "$PROFILE_DIR/SOUL.md"

# Plugin del perfil (el del host lo instala host-setup.sh).
mkdir -p "$PROFILE_DIR/plugins"
ln -sfn "$MCP_HOME/hermes-plugin/cloudisp" "$PROFILE_DIR/plugins/cloudisp"

TOOLS="$(node --input-type=module -e "import { listTools } from '$MCP_HOME/server.mjs'; console.log('[' + listTools({ CLOUDISP_ALLOW_WRITES: '1' }).map((tool) => tool.name).join(', ') + ']')")"

cfg() { hermes -p "$PROFILE" config set "$@" >/dev/null; }

# Plugin y servidor MCP. trust full: las aprobaciones las pide el plugin (en español, una por escritura).
cfg plugins.enabled '[cloudisp]'
cfg plugins.entries.cloudisp.settings.env_file "$ENV_FILE"
cfg plugins.entries.cloudisp.settings.tenant_name "$TENANT"
cfg plugins.entries.cloudisp.settings.bot_name "$BOT_NAME"
cfg plugins.entries.cloudisp.settings.mcp_server cloudisp
cfg mcp_servers.cloudisp.command "$MCP_HOME/bin/cloudisp-mcp"
cfg mcp_servers.cloudisp.args "['$SLUG']"  # entre comillas: un slug como "no" o "on" no es un booleano YAML
cfg mcp_servers.cloudisp.timeout 150
cfg mcp_servers.cloudisp.trust full
cfg mcp_servers.cloudisp.tools.include "$TOOLS"
# Sin skills externas ni memoria; el bot sólo tiene las herramientas de CloudISP, clarify y delegación.
cfg skills.external_dirs '[]'
cfg memory.provider ''
cfg platform_toolsets.telegram '[clarify, delegation]'
# Aprobaciones y comportamiento del chat.
cfg approvals.mode manual
cfg approvals.timeout 300
cfg approvals.destructive_slash_confirm false
cfg display.language es
cfg display.platforms.telegram.tool_progress new
cfg display.platforms.telegram.long_running_notifications generic
cfg display.platforms.telegram.busy_ack_detail false
cfg display.platforms.telegram.cleanup_progress false
cfg auxiliary.title_generation.enabled false
cfg telegram.require_mention true
# Menú de Telegram: sólo /guia y /new.
cfg platforms.telegram.extra.command_menu.priority_mode replace
cfg platforms.telegram.extra.command_menu.priority '[guia, new]'
cfg platforms.telegram.extra.command_menu.max_commands 2
# Lo que el prompt cuenta del equipo y del primer mensaje (el plugin limpia el resto).
cfg agent.environment_probe false
cfg onboarding.profile_build off
# Latido y avisos únicos del motor: frases en español y sin los consejos en inglés (se marcan como ya vistos).
cfg display.status_phrases.mode replace
cfg display.status_phrases.status '[sigo en eso, sigo trabajando en tu pedido, todavía estoy consultando, esto tarda un poco pero sigo, esperando el resultado]'
cfg display.status_phrases.generic '[en eso, un momento, consultando CloudISP]'
cfg onboarding.seen.busy_input_prompt true
cfg onboarding.seen.tool_progress_prompt true

echo "new-tenant: perfil $PROFILE creado ($PROFILE_DIR) y entorno del MCP en $ENV_FILE (modo 600)."
echo "Falta a mano:"
echo "  1. BotFather: nombre \"$BOT_NAME · $TENANT\" y foto (/setuserpic con el logo de CloudISP)."
[ -n "$TG_USER" ] || echo "  2. Completar TELEGRAM_ALLOWED_USERS y TELEGRAM_HOME_CHANNEL en $PROFILE_DIR/.env (id numérico del usuario autorizado)."
echo "  3. host-setup.sh una vez por host (plugin y claves del gateway) y la KB del cliente en el admin."
echo "  4. Reiniciar hermes-gateway SÓLO sin turnos ni delegaciones en curso."
echo "  5. Verificar el arranque: grep -h CLOUDISP_PLUGIN_READY ~/.hermes/logs/gateway.log \"$PROFILE_DIR/logs/gateway.log\" (patches=ok) y que no haya CLOUDISP_PATCH_FAILED en errors.log."
