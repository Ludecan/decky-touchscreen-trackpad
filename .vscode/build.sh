#!/usr/bin/env bash
set -euo pipefail

WORKSPACE_DIR="$(pwd)"
CLI_LOCATION="${WORKSPACE_DIR}/cli/decky"
ROLLUP_ENTRYPOINT="${WORKSPACE_DIR}/node_modules/rollup/dist/bin/rollup"

echo "Building plugin in ${WORKSPACE_DIR}"

if [[ -x "${CLI_LOCATION}" ]]; then
	"${CLI_LOCATION}" plugin build "${WORKSPACE_DIR}"
	exit 0
fi

if [[ -f "${ROLLUP_ENTRYPOINT}" ]]; then
	echo "Decky CLI not found; running frontend build through host node and local rollup."
	flatpak-spawn --host bash -lc "cd '${WORKSPACE_DIR}' && for node_bin in /usr/bin/node /usr/local/bin/node /bin/node /app/bin/node; do if [[ -x \"\$node_bin\" ]]; then exec \"\$node_bin\" './node_modules/rollup/dist/bin/rollup' -c; fi; done; if command -v node >/dev/null 2>&1; then exec node './node_modules/rollup/dist/bin/rollup' -c; fi; echo 'No usable host node found.'; exit 1"
	exit 0
fi

echo "Neither Decky CLI nor pnpm is available. Install one of them and retry."
exit 1
