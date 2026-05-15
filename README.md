# Touchscreen Trackpad Decky Plugin

Decky control panel for the touchscreen trackpad daemon.

## What it does

This plugin talks to the daemon over its JSON IPC socket and uses systemd to start, stop, and restart the service. The daemon remains the single source of truth for runtime config.

## Current scope

- Enable or disable the daemon runtime config
- Tune core motion sliders
- Control the systemd service from Game Mode
- Leave profiles for a future iteration

## Notes on permissions

Starting and stopping the daemon requires system-level permission. The plugin uses `sudo -n systemctl ...` from the Decky backend, so the host should provide a narrow passwordless rule or another root-capable service path.

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

## Deploy

The repo includes VS Code tasks that build the plugin, copy the zip to the SteamOS device, unpack it, and restart Decky.

1. Open [/.vscode/defsettings.json](/home/deck/workspace/decky-touchscreen-trackpad/.vscode/defsettings.json) and set `pluginname` to `Touchscreen Trackpad`.
2. Make sure the SteamOS device connection settings in that file match your Legion Go 2.
3. Run the `builddeploy` task from VS Code, or run `build` and then `deploy`.
4. If you only changed frontend code, `builddeploy` is usually enough.
5. If Decky does not pick up the change immediately, run the `restartdecky` task.

The deploy tasks expect the built zip in `out/`, then rsync it to `${config:deckdir}/homebrew/plugins` and extract it on the Deck.

The `Makefile` deploy target uses `rsync` directly to `~/homebrew/plugins/<plugin-name>` on the Deck, which is easier to run from a terminal and avoids the Decky CLI bootstrap path.

## Socket defaults

The backend checks `TOUCHSCREEN_TRACKPAD_SOCKET` first, then falls back to `/run/touchscreen-trackpad.sock` and `/tmp/touchscreen-trackpad.sock`.
