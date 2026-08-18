#!/bin/sh
set -eu

REPOSITORY="${CODEX_WEB_GPT_REPOSITORY:-naakto14/codex-chatgpt-web}"
VERSION="${CODEX_WEB_GPT_VERSION:-}"
OS="$(uname -s)"
MACHINE="$(uname -m)"

if ! printf '%s\n' "$REPOSITORY" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
  echo "Invalid GitHub repository: $REPOSITORY" >&2
  exit 1
fi

case "$OS" in
  Darwin)
    PLATFORM="mac"
    EXTENSION="zip"
    case "$MACHINE" in
      arm64|aarch64) ARCH="arm64" ;;
      x86_64|amd64) ARCH="x64" ;;
      *) echo "Unsupported macOS architecture: $MACHINE" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    PLATFORM="linux"
    EXTENSION="AppImage"
    case "$MACHINE" in
      x86_64|amd64) ARCH="x64" ;;
      *) echo "The packaged Linux launcher currently supports x86_64; detected $MACHINE" >&2; exit 1 ;;
    esac
    ;;
  *) echo "Use install-launcher.ps1 on Windows; unsupported OS: $OS" >&2; exit 1 ;;
esac

if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 60 \
    "https://api.github.com/repos/$REPOSITORY/releases/latest" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\([^"]*\)".*/\1/p' \
    | head -n 1)"
fi
VERSION="${VERSION#v}"
if [ -z "$VERSION" ]; then
  echo "Could not resolve the latest Codex Web GPT release" >&2
  exit 1
fi
case "$VERSION" in
  *[!A-Za-z0-9._-]*) echo "Invalid release version: $VERSION" >&2; exit 1 ;;
esac

ASSET="codex-web-gpt-$VERSION-$PLATFORM-$ARCH.$EXTENSION"
BASE_URL="https://github.com/$REPOSITORY/releases/download/v$VERSION"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-web-gpt-launcher.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM

curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 900 \
  "$BASE_URL/$ASSET" -o "$TEMP_DIR/$ASSET"
curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 60 \
  "$BASE_URL/checksums.txt" -o "$TEMP_DIR/checksums.txt"
EXPECTED="$(awk -v asset="$ASSET" '$2 == asset { print $1 }' "$TEMP_DIR/checksums.txt")"
if [ "$OS" = "Darwin" ]; then
  ACTUAL="$(shasum -a 256 "$TEMP_DIR/$ASSET" | awk '{ print $1}')"
else
  ACTUAL="$(sha256sum "$TEMP_DIR/$ASSET" | awk '{ print $1}')"
fi
if [ -z "$EXPECTED" ]; then
  echo "checksums.txt has no entry for $ASSET" >&2
  exit 1
fi
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "SHA-256 verification failed for $ASSET" >&2
  exit 1
fi

if [ "$OS" = "Darwin" ]; then
  INSTALL_DIR="${CODEX_WEB_GPT_APPLICATIONS_DIR:-/Applications}"
  STAGE_DIR="$TEMP_DIR/stage"
  mkdir "$STAGE_DIR"
  ditto -x -k "$TEMP_DIR/$ASSET" "$STAGE_DIR"
  SOURCE_APP="$STAGE_DIR/Codex Web GPT.app"
  if [ ! -d "$SOURCE_APP" ] || [ ! -x "$SOURCE_APP/Contents/MacOS/Codex Web GPT" ]; then
    echo "Launcher archive is incomplete" >&2
    exit 1
  fi
  if [ ! -w "$INSTALL_DIR" ]; then
    INSTALL_DIR="$HOME/Applications"
    mkdir -p "$INSTALL_DIR"
  fi
  TARGET_APP="$INSTALL_DIR/Codex Web GPT.app"
  if pgrep -x "Codex Web GPT" >/dev/null 2>&1; then
    echo "Quit Codex Web GPT before updating it" >&2
    exit 1
  fi
  BACKUP_APP="$TEMP_DIR/Codex Web GPT.previous.app"
  if [ -e "$TARGET_APP" ]; then mv "$TARGET_APP" "$BACKUP_APP"; fi
  if ! ditto "$SOURCE_APP" "$TARGET_APP"; then
    rm -rf "$TARGET_APP"
    if [ -e "$BACKUP_APP" ]; then mv "$BACKUP_APP" "$TARGET_APP"; fi
    exit 1
  fi
  echo "Installed $TARGET_APP"
  open "$TARGET_APP"
  exit 0
fi

LIB_DIR="${CODEX_WEB_GPT_LIB_DIR:-$HOME/.local/lib/codex-web-gpt}"
BIN_DIR="${CODEX_WEB_GPT_BIN_DIR:-$HOME/.local/bin}"
TARGET_DIR="$LIB_DIR/$VERSION"
TARGET="$TARGET_DIR/Codex Web GPT.AppImage"
WRAPPER="$BIN_DIR/codex-web-gpt"
CORE_HOME="${CODEX_CHATGPT_WEB_HOME:-$HOME/.codex-chatgpt-web}"
DESCRIPTOR="$CORE_HOME/runtime/launcher-browser.json"
RUNNING_PID=""
if [ -f "$DESCRIPTOR" ]; then
  RUNNING_PID="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$DESCRIPTOR" | head -n 1)"
fi
if { [ -n "$RUNNING_PID" ] && kill -0 "$RUNNING_PID" 2>/dev/null; } \
  || pgrep -f "Codex Web GPT\\.AppImage" >/dev/null 2>&1; then
  echo "Quit Codex Web GPT before updating it" >&2
  exit 1
fi
EXTRACT_DIR="$TEMP_DIR/appimage"
mkdir -p "$EXTRACT_DIR"
chmod 0755 "$TEMP_DIR/$ASSET"
(
  cd "$EXTRACT_DIR"
  "$TEMP_DIR/$ASSET" --appimage-extract >/dev/null
)
ICON_SOURCE="$(find "$EXTRACT_DIR/squashfs-root" -type f -path '*/512x512/*' -name '*.png' | sort | head -n 1)"
if [ -z "$ICON_SOURCE" ]; then
  ICON_SOURCE="$(find "$EXTRACT_DIR/squashfs-root" -type f -name '*.png' | sort | head -n 1)"
fi
if [ -z "$ICON_SOURCE" ]; then
  echo "Launcher AppImage does not contain a PNG application icon" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR" "$BIN_DIR"
TARGET_NEXT="$TARGET.next.$$"
WRAPPER_NEXT="$WRAPPER.next.$$"
trap 'rm -rf "$TEMP_DIR"; rm -f "$TARGET_NEXT" "$WRAPPER_NEXT"' EXIT HUP INT TERM
install -m 0755 "$TEMP_DIR/$ASSET" "$TARGET_NEXT"
mv -f "$TARGET_NEXT" "$TARGET"
shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}
WRAPPER_QUOTED="$(shell_quote "$WRAPPER")"
TARGET_QUOTED="$(shell_quote "$TARGET")"
{
  printf '%s\n' '#!/bin/sh'
  printf '%s\n' 'set -eu'
  printf '%s\n' 'export APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}"'
  printf 'export CODEX_WEB_GPT_LAUNCHER_EXECUTABLE=%s\n' "$WRAPPER_QUOTED"
  printf 'export CODEX_WEB_GPT_APPIMAGE=%s\n' "$TARGET_QUOTED"
  printf 'exec %s "$@"\n' "$TARGET_QUOTED"
} > "$WRAPPER_NEXT"
chmod 0755 "$WRAPPER_NEXT"
mv -f "$WRAPPER_NEXT" "$WRAPPER"

APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"
mkdir -p "$APPLICATIONS_DIR" "$ICON_DIR"
install -m 0644 "$ICON_SOURCE" "$ICON_DIR/codex-web-gpt.png"
DESKTOP_WRAPPER="$(printf '%s' "$WRAPPER" | sed \
  -e 's/\\/\\\\/g' \
  -e 's/"/\\"/g' \
  -e 's/`/\\`/g' \
  -e 's/\$/\\$/g' \
  -e 's/%/%%/g')"
cat > "$APPLICATIONS_DIR/codex-web-gpt.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Codex Web GPT
Comment=ChatGPT Web models inside the native Codex harness
Exec="$DESKTOP_WRAPPER"
Icon=codex-web-gpt
Terminal=false
Categories=Development;
StartupWMClass=codex-web-gpt
EOF
chmod 0644 "$APPLICATIONS_DIR/codex-web-gpt.desktop"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi
echo "Installed $TARGET"
nohup "$WRAPPER" >/dev/null 2>&1 &
