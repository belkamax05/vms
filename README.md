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

**NixOS** is built on the host and booted straight from the host's `/nix/store`
over 9p, so there's no image to build or download. Plugins take effect at build
time, which makes the first boot as fast as any other.

## State and access

Everything a machine writes lives in `~/.local/state/vms/<name>/`: the disk
overlay, the cloud-init seed, the SSH port, the console log (with `-d`), and a
GC root for its build. `vm kill` is a single `rm -rf` of that directory.

`vm` generates one keypair of its own, `~/.local/state/vms/id_ed25519`, on first
use and hands the public key to each guest at boot. Ubuntu gets it through the
cloud-init seed and NixOS through QEMU's fw_cfg. Your own SSH keys never enter a
guest. SSH is forwarded from `127.0.0.1` only, starting at port 2222. The user
(default `maksym`, set by the `user` option) has no password, has passwordless
sudo, and is logged in automatically on the console and on the desktop.

## Checks

```sh
nix flake check   # every machine evaluates, and bin/vm passes shellcheck
```

The check doesn't build or boot any machine, because that would download the
Ubuntu image and a GNOME closure. Booting is the real test: `vm up -d <name> &&
vm ssh <name> true && vm kill <name>`.
