# vms

Throwaway VMs on a machine that has Nix and KVM, and nothing else. The host
side is all Nix: `vm up` builds a machine and boots it, and `vm kill` deletes
everything it wrote. You don't install libvirt or run any system service, and
you never have to set anything up by hand.

The guests are **raw systems**: stock Ubuntu Server and minimal NixOS, each with
one user and SSH. Anything beyond that, including Nix itself on Ubuntu, a
desktop, or later your dotfiles, is an optional **plugin** that a machine chooses
to import.

```sh
vm ls                  # every machine, and whether it's running
vm up nixos            # boot, attached to this terminal (Ctrl-a x to quit)
vm up -d ubuntu        # boot in the background
vm ssh ubuntu          # get in (waits for it to come up)
vm ssh ubuntu uname -a # or run one command
vm key ubuntu          # its own key, vm-ssh - the public half, for GitHub
vm lock ubuntu-gui     # pin an Ubuntu machine's apt packages (see below)
vm down ubuntu         # power off, keep the disk for next time
vm kill ubuntu         # power off and delete everything it wrote
```

GUI machines (`ubuntu-gui`, `nixos-gui`) open a window instead of taking over
the terminal, rendered on your GPU through virgl.

## Layout

```
bin/vm            the host command; mr's link_bins puts it on PATH
flake.nix         machines/* -> packages.<name>; `nix flake check`
machines/         one file per machine, auto-discovered - no registry
plugins/          optional layers a machine imports
lib/
├── options.nix   the contract machines and plugins are written against
├── default.nix   evaluates a machine, wraps it in a uniform runner
├── ubuntu.nix    stock cloud image + a cloud-init seed built from the options
└── nixos.nix     NixOS's own VM runner (what `nixos-rebuild build-vm` uses)
```

## Machines and plugins

A machine is a module. It sets `os` and optionally some sizes:

```nix
# machines/ubuntu-dev.nix
{
  imports = [ ../plugins/nix.nix ../plugins/gui.nix ];
  os = "ubuntu";
  cpus = 8;
  memory = 16384;
}
```

A plugin is another module in the same system (`lib/options.nix`). It sets the
OS-specific half for each OS it supports:

- `ubuntu.packages`, `ubuntu.runcmd`, `ubuntu.writeFiles`, `ubuntu.cloudConfig`
  are cloud-init fragments that run on first boot.
- `nixos.modules` holds ordinary NixOS modules.

The builder for the machine's own OS reads only its half. That lets one plugin
file (see `plugins/gui.nix`) serve both OSes, and a machine can import any mix of
plugins, since list options from all of them concatenate.

| plugin | Ubuntu | NixOS |
| --- | --- | --- |
| `gui` | `ubuntu-desktop-minimal` (GNOME), autologin | GNOME + GDM, autologin |
| `nix` | official multi-user installer, pinned, flakes on | flakes on (NixOS already has Nix) |

## How each OS is built

**Ubuntu** boots Canonical's cloud image unmodified. The image is pinned by URL
and hash in `lib/ubuntu.nix`, and bumping that pin is how you move to a newer
base. Each VM writes to its own copy-on-write overlay. The configuration arrives
as a cloud-init NoCloud seed generated from the options. Plugin packages and
commands therefore run on **first boot** inside the guest: the first `up` of a
machine with `gui` spends several minutes on apt, and later boots of the same
disk skip it.

What apt installs is pinned too, the Nix way. `vm lock <name>` boots the
machine's image as it starts out (its apt preferences, nothing installed) and
asks apt what installing its packages takes, against Ubuntu's snapshot archive
of the image's release day (`snapshot.ubuntu.com`). It writes every `.deb`,
with its sha256, to `machines/<name>.lock.json`, a file you track. The build
then fetches each `.deb` by that hash into the Nix store (from
`archive.ubuntu.com`'s pool, with the snapshot as a fallback) and indexes them
into a local repo. At first boot the runner serves that repo on the host's
loopback, which the guest reaches as `10.0.2.2`, and the guest installs from
it alone. So the same lockfile gives the same bytes on every device, and after
the first fetch nothing depends on any archive being up. The snapshot service
sometimes answers 503 under load, which only slows `vm lock`, since it
retries. A machine whose lockfile is missing, or was resolved for other
packages, refuses to boot and says to run `vm lock`. After the first boot the
guest's own apt sources are the snapshot, for whatever you install by hand.

Snaps can't be pinned, so nothing may install one: the `gui` plugin keeps out
Ubuntu's `firefox` package, a stub that would install the Firefox snap.

A first boot that is cut short, for example by closing the window during the
install, picks up where it stopped on the next `up`. cloud-init marks a step
done as soon as it starts it, so until the last first-boot step has run, each
boot finishes what dpkg was doing and runs the install and plugin steps again.

**NixOS** is built on the host and booted straight from the host's `/nix/store`
over 9p, so there's no image to build or download. Plugins take effect at build
time, which makes the first boot as fast as any other.

## State and access

Everything a machine writes lives in `~/.local/state/vms/<name>/`: the disk
overlay, the cloud-init seed, the SSH port, the console log (with `-d`), its
`vm-ssh` keypair, and a GC root for its build. `vm kill` is a single `rm -rf` of that directory.

`vm` generates one keypair of its own, `~/.local/state/vms/id_ed25519`, on first
use and hands the public key to each guest at boot. Ubuntu gets it through the
cloud-init seed and NixOS through QEMU's fw_cfg. Your own SSH keys never enter a
guest.

Each machine also gets a keypair of its own, `vm-ssh`, created on its first
`up` in its state directory and installed as the guest user's
`~/.ssh/id_ed25519`, through the same channels. It is the guest's identity:
`vm key <name>` prints the public half to add on GitHub as `vm-ssh`. `vm kill`
deletes it with everything else. If `gh` is signed in with the
`admin:public_key` scope (`gh auth refresh -s admin:public_key`), `kill` also
deletes the GitHub key whose text is exactly this one; otherwise it prints the
fingerprint so you can remove it there by hand. SSH is forwarded from `127.0.0.1` only, starting at port 2222. The user
(default `maksym`, set by the `user` option) has no password, has passwordless
sudo, and is logged in automatically on the console and on the desktop.

## Checks

```sh
nix flake check   # every machine evaluates, and bin/vm passes shellcheck
```

The check doesn't build or boot any machine, because that would download the
Ubuntu image and a GNOME closure. Booting is the real test: `vm up -d <name> &&
vm ssh <name> true && vm kill <name>`.
