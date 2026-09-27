#!/usr/bin/env bash
# Instalador de cloudisp-mcp para macOS y Linux.
#
# Uso: curl -fsSL https://raw.githubusercontent.com/CloudISP/cloudisp-mcp/main/install.sh | bash -s -- [env ...]
#      (env por defecto: prod). Para actualizar, volvé a correr el mismo comando.
#
# Clona (o actualiza) el repo público en ~/.local/share/cloudisp-mcp, crea
# ~/.config/cloudisp-mcp/<env>.env desde el ejemplo solo si no existe (modo 600)
# y registra el servidor y las skills en Claude Code, Codex, pi, omp y opencode.
set -euo pipefail

die() { echo "cloudisp-mcp: $*" >&2; exit 1; }

command -v git >/dev/null || die "falta git; instalalo y volvé a correr el instalador"
command -v node >/dev/null || die "falta node (>= 18); instalalo y volvé a correr el instalador"
node -e 'process.exit(+process.versions.node.split(".")[0]>=18?0:1)' || die "node $(node -v) es muy viejo; se requiere node >= 18"

HOME_DIR="${CLOUDISP_MCP_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/cloudisp-mcp}"
REPO_URL="${CLOUDISP_MCP_REPO:-https://github.com/CloudISP/cloudisp-mcp.git}"
CFG_DIR="${CLOUDISP_MCP_CONFIG_DIR:-$HOME/.config/cloudisp-mcp}"

if [ $# -eq 0 ]; then set -- prod; fi

if [ -d "$HOME_DIR/.git" ]; then
    git -C "$HOME_DIR" pull --ff-only --quiet
elif [ -e "$HOME_DIR" ]; then
    die "$HOME_DIR existe pero no es un clon de git; movelo o borralo y reintentá"
else
    mkdir -p "$(dirname "$HOME_DIR")"
    git clone --quiet --depth 1 "$REPO_URL" "$HOME_DIR"
fi
echo "cloudisp-mcp: código en $HOME_DIR ($(git -C "$HOME_DIR" rev-parse --short HEAD))"

for env_name in "$@"; do
    [ -r "$HOME_DIR/config/$env_name.env.example" ] || die "entorno desconocido '$env_name' (no existe config/$env_name.env.example)"
done

mkdir -p "$CFG_DIR"
chmod 700 "$CFG_DIR"
for env_name in "$@"; do
    target="$CFG_DIR/$env_name.env"
    if [ ! -e "$target" ]; then
        cp "$HOME_DIR/config/$env_name.env.example" "$target"
        echo "cloudisp-mcp: creado $target — completá CLOUDISP_API_KEY"
    fi
    chmod 600 "$target"
done

exec node "$HOME_DIR/scripts/register.mjs" "$HOME_DIR" "$CFG_DIR" "$@"
