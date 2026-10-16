#!/usr/bin/env bash
# Configuración del HOST de Hermes que comparten todos los bots de CloudISP (una vez por host; es idempotente).
#
# Uso: host-setup.sh            como el usuario `hermes`, dentro del CT
#
# El gateway multiplexado atiende a todos los perfiles desde el home del host: lee de acá el menú de
# Telegram, la presentación del chat, la política de archivos y los plugins que ven los mensajes
# entrantes (comandos, cupo, /new). Cada bot tiene además su perfil (new-tenant.sh).
# Variables opcionales: HERMES_HOME (la raíz de hermes; también se respeta HERMES_HOME_DIR), CLOUDISP_MCP_HOME, HOST_PLUGINS (lista de plugins del host, por defecto "omh cloudisp").
set -euo pipefail

die() { echo "host-setup: $*" >&2; exit 1; }

MCP_HOME="${CLOUDISP_MCP_HOME:-$HOME/.local/share/cloudisp-mcp}"
# Raíz de Hermes: HERMES_HOME_DIR si se pasa; si no, la variable que usa el propio hermes (HERMES_HOME; si apunta a un perfil,
# su raíz); si no, ~/.hermes. Así el script y `hermes` hablan del mismo lugar.
hermes_root() {
    local home="${HERMES_HOME:-$HOME/.hermes}"

    [ "$(basename "$(dirname "$home")")" = profiles ] && home="$(dirname "$(dirname "$home")")"
    printf '%s' "$home"
}
HERMES_HOME_DIR="${HERMES_HOME_DIR:-$(hermes_root)}"
HOST_PLUGINS="${HOST_PLUGINS:-omh cloudisp}"
ARTIFACTS="$HOME/.cache/cloudisp-artifacts"

command -v hermes >/dev/null || die "falta 'hermes' en el PATH"
[ -r "$MCP_HOME/hermes-plugin/cloudisp/plugin.yaml" ] || die "el checkout de $MCP_HOME no trae hermes-plugin/cloudisp"

# El perfil default no puede tener un bot: dos perfiles con un mismo token chocan. Sólo se miran nombres de claves.
if grep -q '^TELEGRAM_BOT_TOKEN=' "$HERMES_HOME_DIR/.env" 2>/dev/null; then
    die "$HERMES_HOME_DIR/.env define TELEGRAM_BOT_TOKEN: sacá esa línea a mano (el bot vive en el perfil)"
fi

# `-p default` fija el home del host aunque haya un perfil activo (`hermes profile use`) o HERMES_HOME apunte a un perfil.
cfg() { hermes -p default config set "$@" >/dev/null; }

mkdir -p "$HERMES_HOME_DIR/plugins" "$ARTIFACTS"
chmod 700 "$ARTIFACTS"
ln -sfn "$MCP_HOME/hermes-plugin/cloudisp" "$HERMES_HOME_DIR/plugins/cloudisp"

cfg plugins.enabled "[${HOST_PLUGINS// /, }]"
# Archivos al chat: sólo desde la carpeta de los informes.
cfg gateway.strict true
cfg gateway.media_delivery_allow_dirs "[$ARTIFACTS]"
# Menú de Telegram: sólo /guia y /new.
cfg platforms.telegram.extra.command_menu.priority_mode replace
cfg platforms.telegram.extra.command_menu.priority '[guia, new]'
cfg platforms.telegram.extra.command_menu.max_commands 2
# Presentación del chat (el gateway la lee del host) y /new sin tarjeta de confirmación del motor.
cfg display.language es
cfg display.platforms.telegram.tool_progress new
cfg display.platforms.telegram.long_running_notifications generic
cfg display.platforms.telegram.busy_ack_detail false
cfg display.platforms.telegram.cleanup_progress false
cfg approvals.destructive_slash_confirm false
cfg onboarding.profile_build off
# Latido y avisos únicos del motor: frases en español y sin los consejos en inglés (se marcan como ya vistos).
cfg display.status_phrases.mode replace
cfg display.status_phrases.status '[sigo en eso, sigo trabajando en tu pedido, todavía estoy consultando, esto tarda un poco pero sigo, esperando el resultado]'
cfg display.status_phrases.generic '[en eso, un momento, consultando CloudISP]'
cfg onboarding.seen.busy_input_prompt true
cfg onboarding.seen.tool_progress_prompt true

echo "host-setup: listo. Plugin enlazado en $HERMES_HOME_DIR/plugins/cloudisp; reiniciá hermes-gateway SÓLO sin turnos ni delegaciones en curso y verificá el arranque: grep -h CLOUDISP_PLUGIN_READY ~/.hermes/logs/agent.log ~/.hermes/logs/gateway.log (patches=ok), sin CLOUDISP_PATCH_FAILED en errors.log."
