#!/usr/bin/env bash
# Disposable, checksum-pinned native Git. Cache only compiled tools, never results.
set -eu
root="$RUNNER_TEMP/goga-git-compatibility"
mkdir -p "$root"
if [ ! -x "$root/install/bin/git" ]; then
  cd "$root"
  curl --fail --location --max-time 120 https://www.kernel.org/pub/software/scm/git/git-2.45.2.tar.xz -o git-2.45.2.tar.xz
  echo '51bfe87eb1c02fed1484051875365eeab229831d30d0cec5d89a14f9e40e9adb  git-2.45.2.tar.xz' | shasum -a 256 -c -
  tar -xJf git-2.45.2.tar.xz
  make -C git-2.45.2 -j2 prefix="$root/install" RUNTIME_PREFIX=YesPlease NO_GETTEXT=YesPlease NO_TCLTK=YesPlease install
fi
test "$("$root/install/bin/git" --version)" = 'git version 2.45.2'
test "$("$root/install/bin/git" --exec-path)" = "$root/install/libexec/git-core"
echo "$root/install/bin" >> "$GITHUB_PATH"
