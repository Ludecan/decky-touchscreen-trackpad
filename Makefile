SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

SETTINGS_FILE ?= .vscode/settings.json
SETTINGS_JSON := $(if $(wildcard $(SETTINGS_FILE)),$(SETTINGS_FILE),.vscode/defsettings.json)

PLUGIN_NAME ?= $(shell python3 -c "import json, pathlib; p=pathlib.Path('$(SETTINGS_JSON)'); print(json.load(p.open(encoding='utf-8')).get('pluginname', 'Touchscreen Trackpad'))")
DEPLOY_ROOT ?= /home/deck/homebrew/plugins/Touchscreen-Trackpad
DAEMON_REPO ?= ../touchscreen-trackpad
DAEMON_BINARY ?= $(DAEMON_REPO)/target/release/touchscreen-trackpad
DAEMON_INSTALLER ?= $(DAEMON_REPO)/scripts/install-daemon.sh
DAEMON_UNINSTALLER ?= $(DAEMON_REPO)/scripts/uninstall-daemon.sh
DAEMON_CONFIG ?= $(DAEMON_REPO)/config.toml
DAEMON_BUNDLE ?= assets/daemon/touchscreen-trackpad
INSTALLER_BUNDLE ?= assets/daemon/install-daemon.sh
UNINSTALLER_BUNDLE ?= assets/daemon/uninstall-daemon.sh
CONFIG_BUNDLE ?= assets/config.toml

PLUGIN_SLUG := $(shell printf '%s' '$(PLUGIN_NAME)' | sed 's| |-|g')
DEPLOY_DIR := $(DEPLOY_ROOT)

.PHONY: build package-daemon deploy builddeploy clean watch help

help:
	@printf '%s\n' \
		'Available targets:' \
		'  make build       Build the frontend bundle with pnpm or corepack' \
		'  make package-daemon Build and bundle the Rust daemon binary and installer' \
		'  make deploy      Sync plugin files to the Deck over SSH' \
		'  make builddeploy Build first, then deploy' \
		'  make clean       Remove the dist directory' \
		'  make watch       Rebuild on file changes'

build:
	@if command -v pnpm >/dev/null 2>&1; then \
		pnpm run build; \
	elif command -v corepack >/dev/null 2>&1; then \
		corepack pnpm run build; \
	else \
		echo 'pnpm or corepack is required to build.'; \
		exit 1; \
	fi

package-daemon:
	@if [[ ! -x '$(DAEMON_BINARY)' ]]; then \
		echo 'Daemon binary not found at $(DAEMON_BINARY). Build the touchscreen-trackpad repo first.'; \
		exit 1; \
	fi
	@if [[ ! -f '$(DAEMON_INSTALLER)' ]]; then \
		echo 'Daemon installer not found at $(DAEMON_INSTALLER).'; \
		exit 1; \
	fi
	@if [[ ! -f '$(DAEMON_UNINSTALLER)' ]]; then \
		echo 'Daemon uninstaller not found at $(DAEMON_UNINSTALLER).'; \
		exit 1; \
	fi
	@if [[ ! -f '$(DAEMON_CONFIG)' ]]; then \
		echo 'Daemon config not found at $(DAEMON_CONFIG).'; \
		exit 1; \
	fi
	@mkdir -p '$(dir $(DAEMON_BUNDLE))'
	@cp '$(DAEMON_BINARY)' '$(DAEMON_BUNDLE)'
	@chmod 755 '$(DAEMON_BUNDLE)'
	@cp '$(DAEMON_INSTALLER)' '$(INSTALLER_BUNDLE)'
	@chmod 755 '$(INSTALLER_BUNDLE)'
	@cp '$(DAEMON_UNINSTALLER)' '$(UNINSTALLER_BUNDLE)'
	@chmod 755 '$(UNINSTALLER_BUNDLE)'
	@cp '$(DAEMON_CONFIG)' '$(CONFIG_BUNDLE)'

deploy:
	@if [[ ! -d '$(DEPLOY_ROOT)' ]]; then \
		echo 'Deploy root $(DEPLOY_ROOT) is not mounted. Mount /home/deck/homebrew/plugins/Touchscreen-Trackpad into the container first.'; \
		exit 1; \
	fi
	@if [[ ! -w '$(DEPLOY_ROOT)' ]]; then \
		echo 'Deploy root $(DEPLOY_ROOT) is mounted but not writable from this container.'; \
		echo 'Fix host permissions, for example: sudo chown -R deck:deck /home/deck/homebrew/plugins/Touchscreen-Trackpad'; \
		exit 1; \
	fi
	@rsync -rltz --delete --no-owner --no-group --no-perms \
		dist package.json plugin.json main.py README.md LICENSE assets py_modules defaults decky.pyi \
		'$(DEPLOY_DIR)'/

builddeploy: package-daemon build deploy

watch:
	@if command -v pnpm >/dev/null 2>&1; then \
		pnpm run watch; \
	elif command -v corepack >/dev/null 2>&1; then \
		corepack pnpm run watch; \
	else \
		echo 'pnpm or corepack is required to watch build.'; \
		exit 1; \
	fi

clean:
	rm -rf dist