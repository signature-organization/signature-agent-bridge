#!/usr/bin/env bash
# Copyright (c) 2026 Signature Management Consultants SLU
# Author: @ancongui (https://github.com/ancongui)
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
set -euo pipefail
version="0.1.0"
build="audit-1"
repository="signature-organization/signature-agent-bridge"
case "$(uname -s)" in
  Darwin) platform="darwin"; cache="${HOME}/Library/Caches/SignatureAgentBridge" ;;
  Linux) platform="linux"; cache="${XDG_CACHE_HOME:-${HOME}/.cache}/signature-agent-bridge" ;;
  MINGW*|MSYS*|CYGWIN*) platform="win32"; cache="${LOCALAPPDATA:-${HOME}/AppData/Local}/SignatureAgentBridge/cache" ;;
  *) echo "Unsupported operating system." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) architecture="arm64" ;;
  x86_64|amd64) architecture="x64" ;;
  *) echo "Unsupported processor architecture." >&2; exit 1 ;;
esac
if [ "$platform" = "win32" ] && [ "$architecture" != "x64" ]; then
  echo "Use an x64 Git Bash environment on Windows." >&2; exit 1
fi
asset="signature-agent-bridge-$version-$platform-$architecture"
target="$cache/$version-$build-$platform-$architecture"
executable="signature-agent-bridge"
[ "$platform" != "win32" ] || executable="$executable.exe"
mkdir -p "$cache"
if [ ! -x "$target/$executable" ]; then
  # Stage and verify in a unique directory; concurrent hosts never execute a partial download.
  staging="$(mktemp -d "$cache/install.XXXXXX")"
  cleanup() { if [ -n "${staging:-}" ] && [ -d "$staging" ]; then find "$staging" -depth -delete; fi; }
  trap cleanup EXIT
  base="https://github.com/$repository/releases/download/v$version"
  curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 --retry 3 "$base/$asset.tar.gz" -o "$staging/$asset.tar.gz"
  curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 --retry 3 "$base/SHA256SUMS" -o "$staging/SHA256SUMS"
  expected="$(awk -v name="$asset.tar.gz" '$2 == name { print $1 }' "$staging/SHA256SUMS")"
  if [ "${#expected}" -ne 64 ]; then echo "Release checksum is missing." >&2; exit 1; fi
  if command -v sha256sum >/dev/null; then actual="$(sha256sum "$staging/$asset.tar.gz" | awk '{print $1}')"
  else actual="$(shasum -a 256 "$staging/$asset.tar.gz" | awk '{print $1}')"; fi
  if [ "$actual" != "$expected" ]; then echo "Release checksum verification failed." >&2; exit 1; fi
  mkdir "$staging/unpacked"
  tar -xzf "$staging/$asset.tar.gz" -C "$staging/unpacked"
  chmod +x "$staging/unpacked/$executable"
  if [ ! -d "$target" ]; then mv "$staging/unpacked" "$target"; fi
fi
exec "$target/$executable" "$@"
