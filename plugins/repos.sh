#!/bin/sh
# vms-repos (see repos.nix): clone the machine's repos once GitHub accepts its
# vm-ssh key. Started at every desktop login, and at every console or SSH
# login. With every repo already cloned it exits straight away and nothing
# opens; otherwise it works in a terminal - a window of its own on a desktop,
# the login's own otherwise - waits for the key to work, clones what's
# missing and is done.
set -u

# "<url> <dir>" per line, <dir> relative to $HOME - filled in by repos.nix.
REPOS='@REPOS@'

missing() {
  printf '%s\n' "$REPOS" | while read -r url dir; do
    if [ -n "$url" ] && [ ! -d "$HOME/$dir/.git" ]; then printf '%s %s\n' "$url" "$dir"; fi
  done
}

[ -n "$(missing)" ] || exit 0

if [ "${1:-}" != --in-terminal ] && [ "${1:-}" != --in-window ]; then
  for term in ptyxis kgx gnome-terminal; do
    if command -v "$term" >/dev/null; then exec "$term" -- "$0" --in-window; fi
  done
  exec x-terminal-emulator -e "$0" --in-window
fi

# One at a time: the desktop's window and a login shell may both start it. A
# login shell goes on quietly; a window says where the clone is instead of
# closing empty.
lock="${TMPDIR:-/tmp}/vms-repos-$(id -u).lock"
if ! mkdir "$lock" 2>/dev/null; then
  if [ "${1:-}" = --in-window ]; then
    printf 'Cloning already runs in another terminal (an SSH login?) - it carries on there.\n'
    sleep 10
  fi
  exit 0
fi
trap 'rm -rf "$lock"' EXIT

# Five seconds, or less when a key is pressed - for what gets fixed outside the
# guest (vm adds the key to GitHub at `up`, SSO is a click on GitHub), so
# nobody has to press anything here.
pause() {
  old=$(stty -g)
  stty -icanon -echo min 0 time 50
  dd bs=1 count=1 >/dev/null 2>&1
  stty "$old"
}

# Open a GitHub page in the host's browser - there's none in the guest. Only
# the pages lib/default.nix's hostRequests lists: ssh-new, keys.
host_open() {
  printf 'open %s\n' "$1" | sudo -n tee /dev/virtio-ports/vms.host >/dev/null 2>&1 &&
    printf '\nOpened it in your computer'\''s browser.\n'
}

# GitHub answers `ssh -T` with exit 1 either way; what it says tells them apart.
asked_key=
checks=0
while :; do
  said=$(ssh -T -o BatchMode=yes -o ConnectTimeout=10 git@github.com 2>&1)
  case $said in *'successfully authenticated'*) break ;; esac
  clear
  printf 'To clone:\n'
  missing | sed 's/^/  /'
  case $said in
    *'Permission denied'*)
      printf '\nGitHub does not accept this machine'\''s key yet. vm adds it when it\n'
      printf 'boots the machine; if it could not, add it as vm-ssh at\n'
      printf 'https://github.com/settings/ssh/new :\n\n'
      cat "$HOME/.ssh/id_ed25519.pub"
      # Not on the first refusal - vm may be adding it right now - and then
      # once: the page is already open after that.
      checks=$((checks + 1))
      if [ -z "$asked_key" ] && [ "$checks" -ge 3 ]; then host_open ssh-new && asked_key=1; fi
      ;;
    *)
      printf '\nCould not reach GitHub:\n  %s\n' "$said"
      ;;
  esac
  printf '\nChecking again every 5 seconds - any key checks now.\n'
  pause
done

# A key GitHub accepts can still be refused for a repo: by an org that
# enforces SAML SSO - each key needs authorizing for it by hand on GitHub,
# and there's no API for that - or by an account without access. GitHub
# answers such a clone with "Repository not found" as often as with a SAML
# message, so every refusal is handled alike: the keys page (Configure SSO)
# opens in the host's browser, once, and the clone is tried again every few
# seconds until it works - no key to press, no login to repeat.
said=$(mktemp)
status=$(mktemp)
trap 'rm -rf "$said" "$status" "$lock"' EXIT
asked_keys=
tries=0
while list=$(missing) && [ -n "$list" ]; do
  refused=
  orgs=
  while read -r url dir; do
    printf '\nCloning %s into ~/%s\n' "$url" "$dir"
    mkdir -p "$HOME/$(dirname "$dir")"
    # Shown as it runs.
    { git clone --progress "$url" "$HOME/$dir" 2>&1; echo $? > "$status"; } | tee "$said"
    [ "$(cat "$status")" = 0 ] && continue
    refused="$refused $dir"
    orgs="$orgs $(printf '%s' "$url" | sed 's|^[^:]*:||; s|/.*||')"
  done <<EOF
$list
EOF
  [ -n "$refused" ] || continue

  tries=$((tries + 1))
  printf '\nGitHub refused:%s\n' "$refused"
  printf '\nIf an organization enforces SSO, authorize vm-ssh for it: at\n'
  printf 'https://github.com/settings/keys press Configure SSO next to vm-ssh and\n'
  printf 'authorize:\n'
  printf '%s' "$orgs" | tr ' ' '\n' | sed '/^$/d' | sort -u | sed 's/^/  /'
  printf '\nOtherwise the GitHub account vm-ssh is on has no access to them.\n'
  if [ -z "$asked_keys" ]; then host_open keys && asked_keys=1; fi
  printf '\nTrying again every 5 seconds (attempt %s) - any key tries now.\n' "$tries"
  pause
  clear
done

printf '\nAll cloned - closing.\n'
sleep 2
