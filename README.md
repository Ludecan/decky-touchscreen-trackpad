# Touchscreen Trackpad Decky Plugin

Decky control panel for the touchscreen trackpad daemon.

## What it does

This plugin packages the daemon binary and installer script, then calls the daemon's own installer with one button. After that it talks to the daemon over its JSON IPC socket and uses the user's systemd instance to start, stop, and restart the service. The daemon remains the single source of truth for runtime config.

## Current scope

- One-click daemon install into the Deck user's home directory
- Touchscreen-only udev rule plus uinput access rule
- Enable or disable the daemon runtime config
- Tune core motion sliders
- Control the systemd service from Game Mode
- Leave profiles for a future iteration

## Notes on permissions

Starting and stopping the daemon no longer needs sudo. The plugin uses `systemctl --user ...`, and the install button writes the user service plus the rules needed for the touchscreen and `/dev/uinput`.

The actual install logic lives in the daemon repo's `scripts/install-daemon.sh`; the plugin just bundles and invokes it.

The installer creates a stable `/dev/input/touchscreen-trackpad` symlink for the touchscreen and configures the daemon to use it, so the runtime does not need to enumerate all input devices.

## Build

```bash
pnpm i
pnpm run build
```

If you want to use the VS Code task chain instead, run `build` or `builddeploy` after Node and pnpm are installed. The old distrobox bootstrap script is now a no-op.

You can also use the root `Makefile` from a terminal:

```bash
make build
make deploy
make builddeploy
```

## Desktop Preview

You can preview the UI without entering Game Mode by opening [preview.html](preview.html) in a desktop browser. It starts in the not-installed state and lets you switch between the not-installed, stopped, and running states so you can check the simplified header, status indicator, action buttons, and runtime config layout.

## Deploy

The repo assumes the plugin directory itself is mounted into the distrobox container at `/home/deck/homebrew/plugins/Touchscreen-Trackpad`.

1. Make sure the mounted path exists inside the container.
2. Make sure the mounted path is writable by the `deck` user inside the container.
3. If it is not, fix the host permissions first, for example: `sudo chown -R deck:deck /home/deck/homebrew/plugins/Touchscreen-Trackpad`.
4. Run `make builddeploy` from the distrobox container.
5. If you only changed frontend code, `make builddeploy` is usually enough.
6. Restart Decky on the host if it does not pick up the change immediately.

The build step now also expects a packaged daemon binary in `assets/daemon/touchscreen-trackpad`, so the install button can lay down the user service and permissions without asking the user to build the Rust repo on-device.
It also expects `assets/daemon/install-daemon.sh` and `assets/daemon/uninstall-daemon.sh`, which are copied from the daemon repo at package time so the UI can toggle the button between install and uninstall without reimplementing the daemon repo logic.

Install and uninstall failures now include the command, exit code, stdout, and stderr in the Decky toast so permission problems are easier to diagnose.

Plugin errors are also appended to `~/.local/state/touchscreen-trackpad/plugin.log` by default. Set `TOUCHSCREEN_TRACKPAD_PLUGIN_LOG_FILE` if you want to move it.

The `Makefile` deploy target uses `rsync` directly into `/home/deck/homebrew/plugins/Touchscreen-Trackpad` through the mounted host path, which avoids SSH entirely for local development.

## Socket defaults

The backend checks `TOUCHSCREEN_TRACKPAD_SOCKET` first, then falls back to `/tmp/touchscreen-trackpad.sock` and `/run/touchscreen-trackpad.sock`.

# Container creation
distrobox rm dev
distrobox create --name dev --image ubuntu:24.04 --volume /home/deck/homebrew/plugins/Touchscreen-Trackpad:/home/deck/homebrew/plugins/Touchscreen-Trackpad:rw

sudo apt update
sudo apt install -y git build-essential python3
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g npm@11.14.1


sudo npm install -g pnpm


sudo apt install mesa-utils zstd
