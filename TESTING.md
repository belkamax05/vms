# Still to test (left 2026-09-29)

Everything here is implemented, and `nix flake check` passes. These are the boot
tests that weren't finished.

## 0. First: track the new lockfile

`vm lock ubuntu-gui` wrote `machines/ubuntu-gui.lock.json`, with 870 `.deb`s,
each pinned by the sha256 from Ubuntu's signed indexes. The flake only sees
tracked files, so `vm up ubuntu-gui` refuses to boot ("has no
machines/ubuntu-gui.lock.json") until you run:

```sh
git add machines/ubuntu-gui.lock.json
```

`ubuntu-gui` is **stopped** and already provisioned from that lockfile. It was
booted by hand from a `path:` build, so run `vm kill ubuntu-gui` before these
tests to start from a clean disk.

## 1. ubuntu-gui: first boot from the locked debs

```sh
vm kill ubuntu-gui && vm up ubuntu-gui
```

Expect a terminal (tty1 autologin) for a few minutes while it installs, then
GNOME, logged in. The packages come from the host at `10.0.2.2`, not the
internet. To check:

```sh
vm ssh ubuntu-gui 'ls /var/lib/vms/provisioned; systemctl is-active gdm; snap list firefox'
```

`provisioned` should exist, gdm should be `active`, and `firefox` should not be
installed.

## 2. ubuntu-gui: an interrupted first boot resumes

This is the original "just a terminal" bug. During test 1's install, close the
window (or `vm down ubuntu-gui`), then `vm up ubuntu-gui` again. It must finish
the install and reach GNOME by itself. Not yet tested.

## 3. vm-ssh key on Ubuntu

Already tested on NixOS. On Ubuntu:

```sh
vm key ubuntu-gui
vm ssh ubuntu-gui 'cat ~/.ssh/id_ed25519.pub; ssh -T git@github.com'
```

The two public keys should match. After adding it on GitHub as `vm-ssh`,
`ssh -T` should greet you.

## 4. vm kill removes the GitHub copy (optional)

```sh
gh auth refresh -s admin:public_key
```

Then `vm kill <name>` should print "removed vm-ssh from GitHub". Without that
scope, it only prints the fingerprint to remove by hand, which is what happens
today.

## 5. nixos-gui: no lock screen

Your running `nixos-gui` still has the old config. Apply the new one with
`vm down nixos-gui && vm up nixos-gui`. After that there should be no Lock item
in the system menu, Super+L should do nothing, and it should never lock after
idling. The same settings are in `ubuntu-gui`, from test 1.

## Notes

- After changing a machine's packages (or the image pin), run `vm lock <name>`
  again and `git add` the lockfile. A stale lockfile refuses to boot.
- `vm lock` resolves against the live archive and records the time. That
  moment's `snapshot.ubuntu.com` is only a fallback for `.deb`s later pruned
  from the archive. The snapshot service itself was unreliable (503s, and
  inconsistent indexes), so nothing depends on it at boot.
- The plain `ubuntu` machine has a disk left over from an earlier session, with
  no packages. `vm kill ubuntu` if you don't need it.
