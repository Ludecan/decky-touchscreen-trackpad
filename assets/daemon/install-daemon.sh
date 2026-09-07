#!/bin/bash
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BINARY_SOURCE=${1:-$ROOT/target/release/touchscreen-trackpad}
INSTALL_ROOT=${TOUCHSCREEN_TRACKPAD_INSTALL_ROOT:-$HOME/.local/share/touchscreen-trackpad}
INSTALL_BINARY=$INSTALL_ROOT/touchscreen-trackpad
INSTALL_CONFIG=$INSTALL_ROOT/config.toml
USER_UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
USER_UNIT_PATH=$USER_UNIT_DIR/touchscreen-trackpad.service
# Must sort after 60-input-id.rules (sets ID_INPUT_TOUCHSCREEN) but BEFORE
# 73-seat-late.rules: that is where udev queues the "uaccess" builtin that
# actually grants the active session access (ACL) to the touchscreen. A rule
# numbered 99+ only sets the tag after the ACL logic already ran, so it is a
# no-op for permissions (SteamOS grants uaccess late via 90-inputplumber rules).
UDEV_RULE_PATH=/etc/udev/rules.d/72-touchscreen-trackpad.rules
LEGACY_UDEV_RULE_PATH=/etc/udev/rules.d/99-touchscreen-trackpad.rules
SERVICE_NAME=${TOUCHSCREEN_TRACKPAD_SERVICE:-touchscreen-trackpad.service}
SOCKET_PATH=${TOUCHSCREEN_TRACKPAD_SOCKET:-/tmp/touchscreen-trackpad.sock}
RUST_LOG=${RUST_LOG:-info}
LOG_DIR=${TOUCHSCREEN_TRACKPAD_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/touchscreen-trackpad}
LOG_FILE=${TOUCHSCREEN_TRACKPAD_LOG_FILE:-$LOG_DIR/daemon.log}
RULE_FILE=

if [ ! -x "$BINARY_SOURCE" ]; then
  echo "daemon binary not found at $BINARY_SOURCE"
  echo "build it first with: cargo build --release"
  exit 1
fi

if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  systemctl --user stop "$SERVICE_NAME"
fi

mkdir -p "$INSTALL_ROOT"

if [ -f "$ROOT/config.toml" ]; then
  cp "$ROOT/config.toml" "$INSTALL_CONFIG"
else
  cat > "$INSTALL_CONFIG" <<'EOF'
[global]
enabled = true

[region]
x_min = 0.5
x_max = 1.0
y_min = 0.0
y_max = 1.0

[motion]
sensitivity = 4.1
accel_strength = 0.6
accel_exponent = 1.2
smoothing = 0.5
deadzone = 0.0002

[inertia]
enabled = true
friction = 0.97
cutoff = 0.01

[output]
mouse = true
gamepad = false
EOF
fi

TEMP_BINARY=$(mktemp "$INSTALL_ROOT/.touchscreen-trackpad.XXXXXX")
cleanup() {
  rm -f "$TEMP_BINARY"
  rm -f "$RULE_FILE"
}
trap cleanup EXIT HUP INT TERM

cp "$BINARY_SOURCE" "$TEMP_BINARY"
chmod 755 "$TEMP_BINARY"
mv -f "$TEMP_BINARY" "$INSTALL_BINARY"
trap - EXIT HUP INT TERM

mkdir -p "$LOG_DIR"
touch "$LOG_FILE"

mkdir -p "$USER_UNIT_DIR"
cat > "$USER_UNIT_PATH" <<EOF
[Unit]
Description=Touchscreen Trackpad daemon
After=graphical-session.target
# The plugin restarts this service when the [output] config changes; disable
# systemd's start-rate limiting so a quick restart can't trip
# "start request repeated too quickly" and surface as a config error.
StartLimitIntervalSec=0
StartLimitBurst=0

[Service]
Type=simple
ExecStart=$INSTALL_BINARY $INSTALL_CONFIG
Environment=TOUCHSCREEN_TRACKPAD_SOCKET=$SOCKET_PATH
Environment=RUST_LOG=$RUST_LOG
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF

RULE_FILE=$(mktemp)
cat > "$RULE_FILE" <<'EOF'
# Touchscreen Trackpad installer-managed permissions
# Numbered 72 so it runs after 60-input-id.rules (ID_INPUT_TOUCHSCREEN) and
# before 73-seat-late.rules, where udev queues the uaccess builtin that grants
# the active seat session an ACL on the device node. TAG+="seat" is required
# because SteamOS assigns uaccess too late (90-inputplumber) for the seat tag.
SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_TOUCHSCREEN}=="1", TAG+="seat", TAG+="uaccess", SYMLINK+="input/touchscreen-trackpad"
# Output devices created via uinput also need session access, otherwise the
# daemon can write events but compositors/Steam running as the user cannot
# open the virtual mouse/gamepad nodes.
KERNEL=="event*", SUBSYSTEM=="input", ATTRS{name}=="Touchscreen Trackpad Virtual Mouse", TAG+="seat", TAG+="uaccess"
KERNEL=="event*", SUBSYSTEM=="input", ATTRS{name}=="Touchscreen Trackpad Virtual Gamepad", TAG+="seat", TAG+="uaccess"
KERNEL=="js[0-9]*", SUBSYSTEM=="input", ATTRS{name}=="Touchscreen Trackpad Virtual Gamepad", TAG+="seat", TAG+="uaccess"
KERNEL=="uinput", TAG+="uaccess"
EOF

if command -v sudo >/dev/null 2>&1; then
  sudo install -Dm644 "$RULE_FILE" "$UDEV_RULE_PATH"
  sudo rm -f "$LEGACY_UDEV_RULE_PATH"
  if command -v udevadm >/dev/null 2>&1; then
    sudo udevadm control --reload-rules
    sudo udevadm trigger --subsystem-match=input
  else
    echo "udevadm is not available here; the rule was installed, but the host udev rules were not reloaded automatically."
  fi
else
  echo "sudo is required to install udev rules at $UDEV_RULE_PATH"
  rm -f "$RULE_FILE"
  exit 1
fi
rm -f "$RULE_FILE"

systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"

printf 'Installed and started %s\n' "$SERVICE_NAME"
printf 'Binary: %s\n' "$INSTALL_BINARY"
printf 'Config: %s\n' "$INSTALL_CONFIG"
printf 'Unit: %s\n' "$USER_UNIT_PATH"
printf 'Socket: %s\n' "$SOCKET_PATH"
