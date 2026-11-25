#!/usr/bin/env bash
# Vuelve a escribir el SOUL.md de un bot con el template actual, sin recrear el perfil (new-tenant.sh usa este mismo paso).
#
# Uso: render-soul.sh <slug> ["<Nombre del cliente>"]
#
# Sin nombre de cliente, el del bot y el del cliente salen de la primera línea del SOUL.md del perfil ("# <bot> · <cliente>").
# Después reiniciá hermes-gateway SÓLO sin turnos ni delegaciones en curso: el prompt se lee al empezar cada conversación.
# Variables opcionales: HERMES_HOME (la raíz de hermes; también se respeta HERMES_HOME_DIR), CLOUDISP_MCP_HOME, BOT_NAME.
set -euo pipefail
umask 077

die() { echo "render-soul: $*" >&2; exit 1; }

[ $# -ge 1 ] && [ $# -le 2 ] || die "uso: render-soul.sh <slug> [\"<Nombre del cliente>\"]"
SLUG="$1"; TENANT="${2:-}"
[[ "$SLUG" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "slug inválido: minúsculas, números y guiones (2 a 31 caracteres)"

# Raíz de Hermes: HERMES_HOME_DIR si se pasa; si no, la variable que usa el propio hermes (HERMES_HOME; si apunta a un perfil,
# su raíz); si no, ~/.hermes. Así el script y `hermes` hablan del mismo lugar.
hermes_root() {
    local home="${HERMES_HOME:-$HOME/.hermes}"

    [ "$(basename "$(dirname "$home")")" = profiles ] && home="$(dirname "$(dirname "$home")")"
    printf '%s' "$home"
}
HERMES_HOME_DIR="${HERMES_HOME_DIR:-$(hermes_root)}"
MCP_HOME="${CLOUDISP_MCP_HOME:-$HOME/.local/share/cloudisp-mcp}"
TEMPLATE="$MCP_HOME/deploy/hermes-tenant/SOUL.md.tmpl"
PROFILE_DIR="$HERMES_HOME_DIR/profiles/cloudisp-$SLUG"
SOUL_FILE="$PROFILE_DIR/SOUL.md"

[ -r "$TEMPLATE" ] || die "no encuentro el template en $TEMPLATE (¿checkout del tag?)"
[ -d "$PROFILE_DIR" ] || die "el perfil cloudisp-$SLUG no existe ($PROFILE_DIR)"

if [ -z "$TENANT" ]; then
    [ -r "$SOUL_FILE" ] || die "$SOUL_FILE no existe: pasá el nombre del cliente"
    first="$(head -n 1 "$SOUL_FILE")"
    [[ "$first" == "# "*" · "* ]] || die "no reconozco la primera línea de $SOUL_FILE (\"# <bot> · <cliente>\"): pasá el nombre del cliente"
    first="${first#\# }"
    BOT_NAME="${BOT_NAME:-${first%% · *}}"
    TENANT="${first#* · }"
fi
BOT_NAME="${BOT_NAME:-Asistente CloudISP}"
[[ -n "$TENANT" && "$TENANT" != *$'\n'* ]] || die "el nombre del cliente no puede estar vacío ni tener saltos de línea"

shopt -u patsub_replacement 2>/dev/null || true
SOUL="$(< "$TEMPLATE")"
SOUL="${SOUL//\{BOT_NAME\}/$BOT_NAME}"
SOUL="${SOUL//\{TENANT_NAME\}/$TENANT}"
printf '%s\n' "$SOUL" > "$SOUL_FILE"

echo "render-soul: SOUL.md de cloudisp-$SLUG actualizado ($SOUL_FILE). Reiniciá hermes-gateway SÓLO sin turnos ni delegaciones en curso."
