SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

SETTINGS_FILE ?= .vscode/settings.json
SETTINGS_JSON := $(if $(wildcard $(SETTINGS_FILE)),$(SETTINGS_FILE),.vscode/defsettings.json)

PLUGIN_NAME ?= $(shell python3 -c "import json, pathlib; p=pathlib.Path('$(SETTINGS_JSON)'); print(json.load(p.open(encoding='utf-8')).get('pluginname', 'Touchscreen Trackpad'))")
REMOTE_HOST ?= $(shell python3 -c "import json, pathlib; p=pathlib.Path('$(SETTINGS_JSON)'); print(json.load(p.open(encoding='utf-8')).get('deckip', ''))")
REMOTE_PORT ?= $(shell python3 -c "import json, pathlib; p=pathlib.Path('$(SETTINGS_JSON)'); print(json.load(p.open(encoding='utf-8')).get('deckport', '22'))")
REMOTE_USER ?= $(shell python3 -c "import json, pathlib; p=pathlib.Path('$(SETTINGS_JSON)'); print(json.load(p.open(encoding='utf-8')).get('deckuser', 'deck'))")
REMOTE_DIR ?= /home/deck/homebrew/plugins
SSH_OPTS ?=

PLUGIN_SLUG := $(shell printf '%s' '$(PLUGIN_NAME)' | sed 's| |-|g')
REMOTE_PLUGIN_DIR := $(REMOTE_DIR)/$(PLUGIN_SLUG)

.PHONY: build deploy builddeploy clean watch help

help:
	@printf '%s\n' \
		'Available targets:' \
		'  make build       Build the frontend bundle with pnpm or corepack' \
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

deploy:
	@if [[ -z '$(REMOTE_HOST)' ]]; then \
		echo 'Remote host is not configured. Set deckip in .vscode/settings.json or pass REMOTE_HOST=...'; \
		exit 1; \
	fi
	@if ! ssh -p $(REMOTE_PORT) $(SSH_OPTS) -o BatchMode=yes -o ConnectTimeout=5 $(REMOTE_USER)@$(REMOTE_HOST) true >/dev/null 2>&1; then \
		echo 'SSH is not reachable on $(REMOTE_HOST):$(REMOTE_PORT). Start sshd on the SteamOS device or check the hostname/IP.'; \
		exit 1; \
	fi
	@ssh -p $(REMOTE_PORT) $(SSH_OPTS) $(REMOTE_USER)@$(REMOTE_HOST) "mkdir -p '$(REMOTE_PLUGIN_DIR)'"
	@rsync -azp -e "ssh -p $(REMOTE_PORT) $(SSH_OPTS)" \
		dist package.json plugin.json main.py README.md LICENSE assets py_modules defaults decky.pyi \
		$(REMOTE_USER)@$(REMOTE_HOST):'$(REMOTE_PLUGIN_DIR)'/

builddeploy: build deploy

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