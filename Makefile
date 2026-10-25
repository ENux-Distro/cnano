# cnano — build & install onto the host.
#
#   make                         build (npm install + native rebuild + staging)
#   sudo make install            install to /usr/local
#   make install PREFIX=~/.local install for your user only (no sudo)
#   sudo make uninstall          remove it again (same PREFIX as install)
#
# Installs two programs: `cnano` (GUI) and `cnano-tui` (terminal; also `cnano --tui`).

PREFIX  ?= /usr/local
DESTDIR ?=
BINDIR  := $(DESTDIR)$(PREFIX)/bin
LIBDIR  := $(DESTDIR)$(PREFIX)/lib/cnano
APPDIR  := $(DESTDIR)$(PREFIX)/share/applications
ICONDIR := $(DESTDIR)$(PREFIX)/share/icons/hicolor/scalable/apps

STAGE   := build/stage
APP_SRC := main.js agent.js lsp.js preload.js package.json package-lock.json renderer

# Language servers (pyright, rust-analyzer, asm-lsp) → ~/.local/share/cnano/lsp; clangd comes from your distro.
.PHONY: all deps stage stage-tui lsp test test-quick install uninstall run run-tui clean distclean check

all: stage stage-tui

# Dev dependencies are needed here: electron (runtime) and @electron/rebuild (node-pty for Electron's ABI).
node_modules/.package-lock.json: package.json package-lock.json
	@command -v npm >/dev/null || { echo "npm is required (install nodejs + npm)"; exit 1; }
	@command -v g++ >/dev/null && command -v make >/dev/null || { echo "g++ and make are required to build node-pty"; exit 1; }
	npm install
	@touch $@

deps: node_modules/.package-lock.json

check: deps
	npm run --silent check

# Self-contained copy: app sources + production node_modules (with the rebuilt node-pty) + Electron runtime.
stage: check
	rm -rf $(STAGE)/app $(STAGE)/electron
	mkdir -p $(STAGE)/app
	cp -r $(APP_SRC) $(STAGE)/app/
	cp -r node_modules $(STAGE)/app/
	cd $(STAGE)/app && npm prune --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null
	# Trim what the runtime never loads: Monaco's ESM/dev builds, node-pty sources and foreign prebuilds.
	cd $(STAGE)/app/node_modules && rm -rf monaco-editor/esm monaco-editor/dev \
		node-pty/prebuilds node-pty/deps node-pty/third_party node-pty/src node-pty/build/Release/obj.target
	find $(STAGE)/app/node_modules -type d -empty -delete
	cp -r node_modules/electron/dist $(STAGE)/electron
	@echo "staged in $(STAGE) ($$(du -sh $(STAGE) | cut -f1))"

# The TUI's Python deps (Textual + tree-sitter grammars) go into a private --target dir,
# built with the host python3 so the native wheels match the interpreter that runs it.
stage-tui:
	@command -v python3 >/dev/null || { echo "python3 is required for cnano-tui"; exit 1; }
	rm -rf $(STAGE)/tui build/venv
	python3 -m venv build/venv
	build/venv/bin/pip install -q --upgrade pip
	build/venv/bin/pip install -q --target $(STAGE)/tui ./tui
	rm -rf $(STAGE)/tui/bin
	PYTHONPATH=$(STAGE)/tui python3 -c "import cnano_tui.app, tree_sitter_c" && echo "tui staged in $(STAGE)/tui"

install: $(STAGE)/app/main.js
	@[ -d $(STAGE)/electron ] && [ -d $(STAGE)/tui ] || { echo "run 'make' first"; exit 1; }
	rm -rf $(LIBDIR)
	install -d $(LIBDIR) $(BINDIR) $(APPDIR) $(ICONDIR)
	cp -r $(STAGE)/app $(STAGE)/electron $(STAGE)/tui $(LIBDIR)/
	# Chromium's setuid sandbox helper must be root-owned + suid when installed system-wide.
	@if [ "$$(id -u)" = 0 ]; then chown root:root $(LIBDIR)/electron/chrome-sandbox && chmod 4755 $(LIBDIR)/electron/chrome-sandbox; fi
	sed 's|@LIBDIR@|$(PREFIX)/lib/cnano|' bin/cnano.in > $(BINDIR)/cnano
	sed 's|@LIBDIR@|$(PREFIX)/lib/cnano|' bin/cnano-tui.in > $(BINDIR)/cnano-tui
	chmod 755 $(BINDIR)/cnano $(BINDIR)/cnano-tui
	sed 's|@BINDIR@|$(PREFIX)/bin|' assets/cnano.desktop.in > $(APPDIR)/cnano.desktop
	install -m 644 assets/cnano.svg $(ICONDIR)/cnano.svg
	-@command -v update-desktop-database >/dev/null && update-desktop-database -q $(APPDIR) 2>/dev/null || true
	-@command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -qtf $(DESTDIR)$(PREFIX)/share/icons/hicolor 2>/dev/null || true
	@echo
	@echo "cnano installed to $(PREFIX). Run: cnano [folder|file]"
	@case ":$$PATH:" in *":$(PREFIX)/bin:"*) ;; *) echo "note: $(PREFIX)/bin is not on your PATH";; esac

$(STAGE)/app/main.js:
	@echo "nothing staged — run 'make' (without sudo) first"; exit 1

uninstall:
	rm -rf $(LIBDIR)
	rm -f $(BINDIR)/cnano $(BINDIR)/cnano-tui $(APPDIR)/cnano.desktop $(ICONDIR)/cnano.svg
	@echo "cnano removed from $(PREFIX) (settings stay in ~/.config/cnano)"

lsp:
	scripts/install-lsp.sh

# Environment checks + unit tests. test-quick skips the live `claude -p` call.
test:
	@[ -d $(STAGE)/tui ] || $(MAKE) stage-tui
	cd tests && python3 -m unittest -v test_environment test_logic

test-quick:
	@[ -d $(STAGE)/tui ] || $(MAKE) stage-tui
	cd tests && CNANO_SKIP_CLAUDE=1 python3 -m unittest -v test_environment test_logic

run: deps
	npx electron .

run-tui:
	@[ -d $(STAGE)/tui ] || $(MAKE) stage-tui
	PYTHONPATH=$(STAGE)/tui python3 -m cnano_tui

clean:
	rm -rf build

distclean: clean
	rm -rf node_modules
