#!/usr/bin/env bash
# Prepares /home/container into a runnable server directory, then execs the server.
#
# The server resolves everything relative to its working directory: it requires
# ./scam_native.node, reads ./server-settings.json, loads ./gamemode.js and
# reads ./dist_back/skymp5-server.js.map. So the working directory, not the
# image, is the server directory.

set -euo pipefail

ALDUINAK_HOME="${ALDUINAK_HOME:-/opt/alduinak}"
DATA_DIR="${DATA_DIR:-data}"

log() { echo "[entrypoint] $*"; }

# Pterodactyl startup commands call this script explicitly, and some Wings
# configurations also apply the image ENTRYPOINT. Run the preparation once.
if [ -n "${ALDUINAK_ENTRYPOINT_DONE:-}" ]; then
  exec "$@"
fi
export ALDUINAK_ENTRYPOINT_DONE=1

# ── Runtime artifacts ────────────────────────────────────────────────────────
# Recreated every boot so an image upgrade is picked up and a deleted symlink
# self-heals. The operator's own files are never touched.
ln -sfn "${ALDUINAK_HOME}/scam_native.node" ./scam_native.node
ln -sfn "${ALDUINAK_HOME}/dist_back"        ./dist_back

# ── Game data ────────────────────────────────────────────────────────────────
# scripts/ is not optional: ScriptStorageFactory always registers it as a
# directory storage and the iterator throws if it is missing, which stops the
# server before it ever opens a socket.
mkdir -p "${DATA_DIR}" "${DATA_DIR}/scripts"

# Dev image only: seed the Bethesda files baked into the image
if [ -n "${ALDUINAK_DEV_DATA:-}" ] && [ -d "${ALDUINAK_DEV_DATA}" ]; then
  for src in "${ALDUINAK_DEV_DATA}"/*.esm; do
    [ -e "$src" ] || continue
    dst="${DATA_DIR}/$(basename "$src")"
    if [ ! -f "$dst" ]; then
      log "seeding $(basename "$src") from the dev image"
      cp "$src" "$dst"
    fi
  done
fi

REQUIRED_ESM="Skyrim.esm Update.esm Dawnguard.esm HearthFires.esm Dragonborn.esm"
missing=""
for esm in ${REQUIRED_ESM}; do
  [ -f "${DATA_DIR}/${esm}" ] || missing="${missing} ${esm}"
done

if [ -n "${missing}" ]; then
  cat >&2 <<EOF

[entrypoint] ERROR: missing Skyrim master files in ./${DATA_DIR}:${missing}

  The server cannot start without them. They are part of your own Skyrim
  Special Edition installation and are not distributed with this image.

  Copy them from:
    <Steam>/steamapps/common/Skyrim Special Edition/Data/

  into this server's ${DATA_DIR}/ directory, then start the server again.

EOF
  exit 1
fi

# ── Settings ─────────────────────────────────────────────────────────────────
node "${ALDUINAK_HOME}/render-settings.js" server-settings.json

# ── Gamemode ─────────────────────────────────────────────────────────────────
# Precedence: operator's gamemode_extensions/ > existing gamemode.js > empty.
# A broken part aborts the boot rather than quietly running the previous
# gamemode, which would look like a successful deploy of the broken one.
if [ -d gamemode_extensions ]; then
  if ! node "${ALDUINAK_HOME}/build-gamemode.js" gamemode_extensions gamemode.js; then
    echo "[entrypoint] ERROR: gamemode_extensions failed to build, refusing to start." >&2
    echo "[entrypoint] The previous gamemode.js is intact. Fix the part above and restart." >&2
    exit 1
  fi
fi

if [ ! -f gamemode.js ]; then
  log "no gamemode.js found, writing an empty one (bare server)"
  cat > gamemode.js <<'EOF'
// Empty gamemode: the server runs, players connect and spawn, and no roleplay
// logic is applied. Replace this file, or drop parts into gamemode_extensions/.
EOF
fi

# FileDatabase writes here when databaseDriver is "file"
mkdir -p world

log "starting: $*"
exec "$@"
