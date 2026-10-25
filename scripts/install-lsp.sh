#!/bin/sh
# Install language servers for cnano into ~/.local/share/cnano/lsp (no global changes).
#   clangd        — C/C++  (use your distro package: clangd / clang-tools)
#   pyright       — Python (npm)
#   rust-analyzer — Rust   (official prebuilt binary)
#   asm-lsp       — Assembly (cargo install)
# Usage: scripts/install-lsp.sh [pyright] [rust-analyzer] [asm-lsp]   (default: all missing)
set -eu
DIR="${CNANO_LSP_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/cnano/lsp}"
BIN="$DIR/bin"
mkdir -p "$BIN"
have() { command -v "$1" >/dev/null 2>&1 || [ -x "$BIN/$1" ]; }
want() { [ $# -eq 0 ] || [ -z "$WANT" ] || case " $WANT " in *" $1 "*) return 0;; *) return 1;; esac; }
WANT="$*"

if want pyright && ! have pyright-langserver; then
  echo "==> pyright"
  command -v npm >/dev/null || { echo "   npm not found, skipping"; }
  if command -v npm >/dev/null; then
    npm install --silent --no-audit --no-fund --prefix "$DIR/pyright" pyright
    ln -sf "$DIR/pyright/node_modules/.bin/pyright-langserver" "$BIN/pyright-langserver"
  fi
fi

if want rust-analyzer && ! have rust-analyzer; then
  echo "==> rust-analyzer"
  case "$(uname -m)" in
    x86_64) triple=x86_64-unknown-linux-gnu ;;
    aarch64) triple=aarch64-unknown-linux-gnu ;;
    *) triple= ;;
  esac
  if [ -n "$triple" ]; then
    curl -fsSL "https://github.com/rust-lang/rust-analyzer/releases/latest/download/rust-analyzer-$triple.gz" | gunzip > "$BIN/rust-analyzer.tmp"
    chmod +x "$BIN/rust-analyzer.tmp" && mv "$BIN/rust-analyzer.tmp" "$BIN/rust-analyzer"
  else
    echo "   no prebuilt binary for $(uname -m), skipping"
  fi
fi

if want asm-lsp && ! have asm-lsp; then
  echo "==> asm-lsp (compiling, takes a few minutes)"
  if command -v cargo >/dev/null; then
    cargo install --quiet --locked --root "$DIR/cargo" asm-lsp
    ln -sf "$DIR/cargo/bin/asm-lsp" "$BIN/asm-lsp"
  else
    echo "   cargo not found, skipping"
  fi
fi

have clangd || echo "note: clangd not found — install it from your distro (clangd / clang-tools) for C/C++."
echo "language servers in $BIN:"; ls -1 "$BIN"
