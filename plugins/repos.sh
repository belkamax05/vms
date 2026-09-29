#!/bin/sh
# vms-repos (see repos.nix): clone the machine's repos once GitHub accepts its
# vm-ssh key. Started at every desktop login. With every repo already cloned it
# exits straight away and no window opens; otherwise it reopens itself in a
# terminal, waits for the key to work, clones what's missing and closes.
set -u

# "<url> <dir>" per line, <dir> relative to $HOME - filled in by repos.nix.
REPOS='@REPOS@'

missing() {
  printf '%s\n' "$REPOS" | while read -r url dir; do
    if [ -n "$url" ] && [ ! -d "$HOME/$dir/.git" ]; then printf '%s %s\n' "$url" "$dir"; fi
  done
}

[ -n "$(missing)" ] || exit 0

if [ "${1:-}" != --in-terminal ]; then
  for term in ptyxis kgx gnome-terminal; do
    if command -v "$term" >/dev/null; then exec "$term" -- "$0" --in-terminal; fi
  done
  exec x-terminal-emulator -e "$0" --in-terminal
fi

# One keypress, without Enter.
key() {
  old=$(stty -g)
  stty -icanon -echo
  dd bs=1 count=1 2>/dev/null
  stty "$old"
}

wait_space() {
  until [ "$(key)" = ' ' ]; do :; done
}

# Open a GitHub page in the host's browser - there's none in the guest. Only
# the pages lib/default.nix's hostRequests lists: ssh-new, keys.
host_open() {
  printf 'open %s\n' "$1" | sudo -n tee /dev/virtio-ports/vms.host >/dev/null 2>&1 &&
    printf '\nOpened it in your computer'\''s browser.\n'
}

# GitHub answers `ssh -T` with exit 1 either way; what it says tells them apart.
asked_key=
while :; do
  said=$(ssh -T -o BatchMode=yes -o ConnectTimeout=10 git@github.com 2>&1)
  case $said in *'successfully authenticated'*) break ;; esac
  clear
  printf 'To clone:\n'
  missing | sed 's/^/  /'
  case $said in
    *'Permission denied'*)
      printf '\nGitHub does not accept this machine'\''s key yet. Add it as vm-ssh at\n'
      printf 'https://github.com/settings/ssh/new :\n\n'
      cat "$HOME/.ssh/id_ed25519.pub"
      # Once, not on every Space: the page is already open after that.
      if [ -z "$asked_key" ]; then host_open ssh-new && asked_key=1; fi
      ;;
    *)
      printf '\nCould not reach GitHub:\n  %s\n' "$said"
      ;;
  esac
  printf '\nPress Space to check again.\n'
  wait_space
done

# A key GitHub accepts can still be refused by an org that enforces SAML SSO:
# each key needs authorizing for it by hand, and there's no API for that. Such
# a clone waits here for that click; any other failure ends the run, to be
# tried again at the next login.
said=$(mktemp)
status=$(mktemp)
trap 'rm -f "$said" "$status"' EXIT
asked_sso=
while list=$(missing) && [ -n "$list" ]; do
  sso=
  failed=
  while read -r url dir; do
    printf '\nCloning %s into ~/%s\n' "$url" "$dir"
    mkdir -p "$HOME/$(dirname "$dir")"
    # Shown as it runs, and kept to tell SSO apart from other failures.
    { git clone --progress "$url" "$HOME/$dir" 2>&1; echo $? > "$status"; } | tee "$said"
    [ "$(cat "$status")" = 0 ] && continue
    if grep -q 'SAML SSO' "$said"; then
      sso="$sso $(printf '%s' "$url" | sed 's|^[^:]*:||; s|/.*||')"
    else
      failed="$failed $dir"
    fi
  done <<EOF
$list
EOF

  if [ -n "$sso" ]; then
    printf '\nGitHub accepts the key, but these organizations need it authorized for SSO:\n'
    printf '%s' "$sso" | tr ' ' '\n' | sed '/^$/d' | sort -u | sed 's/^/  /'
    printf '\nAt https://github.com/settings/keys, press Configure SSO next to vm-ssh and\n'
    printf 'authorize each of them. Then press Space to try again.\n'
    if [ -z "$asked_sso" ]; then host_open keys && asked_sso=1; fi
    wait_space
  elif [ -n "$failed" ]; then
    printf '\nFailed:%s - they are tried again at the next login.\nPress Space to close.\n' "$failed"
    wait_space
    exit 1
  fi
done

printf '\nAll cloned - closing.\n'
sleep 2
