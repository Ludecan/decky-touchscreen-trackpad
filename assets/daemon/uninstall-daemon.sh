#!/bin/bash
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INSTALL_ROOT=${TOUCHSCREEN_TRACKPAD_INSTALL_ROOT:-$HOME/.local/share/touchscreen-trackpad}
INSTALL_BINARY=$INSTALL_ROOT/touchscreen-trackpad
INSTALL_CONFIG=$INSTALL_ROOT/config.toml
USER_UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
USER_UNIT_PATH=$USER_UNIT_DIR/touchscreen-trackpad.service
UDEV_RULE_PATH=/etc/udev/rules.d/99-touchscreen-trackpad.rules
SERVICE_NAME=${TOUCHSCREEN_TRACKPAD_SERVICE:-touchscreen-trackpad.service}
LOG_DIR=${TOUCHSCREEN_TRACKPAD_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/touchscreen-trackpad}
LOG_FILE=${TOUCHSCREEN_TRACKPAD_LOG_FILE:-$LOG_DIR/daemon.log}

if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  systemctl --user stop "$SERVICE_NAME"
fi

systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
systemctl --user daemon-reload

rm -f "$USER_UNIT_PATH"
rm -f "$INSTALL_BINARY"
rm -f "$INSTALL_CONFIG"
rm -rf "$INSTALL_ROOT"
rm -f "$LOG_FILE"
rmdir "$LOG_DIR" 2>/dev/null || true

if command -v sudo >/dev/null 2>&1; then
  sudo rm -f "$UDEV_RULE_PATH"
  if command -v udevadm >/dev/null 2>&1; then
    sudo udevadm control --reload-rules
    sudo udevadm trigger --subsystem-match=input
  else
    echo "udevadm is not available here; the rule was removed, but the host udev rules were not reloaded automatically."
  fi
else
  echo "sudo is required to remove udev rules at $UDEV_RULE_PATH"
  echo "The user service and installed binary were removed, but the udev rule may remain."
fi

printf 'Uninstalled %s\n' "$SERVICE_NAME"
printf 'Removed unit: %s\n' "$USER_UNIT_PATH"
printf 'Removed binary: %s\n' "$INSTALL_BINARY"
printf 'Removed config: %s\n' "$INSTALL_CONFIG"
printf 'Removed log: %s\n' "$LOG_FILE"
