# vms - instructions for AI agents

Read `README.md` first. This file lists only the invariants.

## Never run git operations without an explicit, in-the-moment ask

Don't run `git add`, `commit`, `reset`, `stash`, `rm`, or any other git
command that changes state unless the user has just asked for that specific
action. The user stages and commits everything themselves. See
`~/dotfiles/AGENTS.md` for the full rule, which applies here unchanged.

## Invariants

- **Guests stay raw.** `lib/ubuntu.nix` and `lib/nixos.nix` hold only what
  it takes to log in and to be reached (a user, SSH, console autologin, the
  machine's own `vm-ssh` key) and to provision reproducibly (the apt
  snapshot, resumable first boot). Anything else,
  including Nix on Ubuntu, a desktop, or dotfiles, goes in a `plugins/`
  file that a machine opts into. Never put it in a builder.
- **One plugin file serves both OSes.** A plugin sets `ubuntu.*` and/or
  `nixos.modules`. Don't split a plugin into per-OS files, and don't
  branch on `os` inside one.
- **Every machine produces the same runner shape** (`bin/vm-run` + `meta`,
  see `lib/default.nix`). `vm` (`apps/vm`) must never branch on the OS
  beyond hiding an action that can't apply (`Lock` on NixOS).
- **Other repos extend this one; keep that API whole.** `flake.nix`'s `lib`
  (`mkMachines`, `mkMachinesCheck`), the `vms` module argument (this repo's
  root, for importing its machines/plugins), lockfiles next to the machine's
  own file, and `VMS_REPO` for `vm` are what `~/dfs/vms-dfs` is built on.
  Nothing may assume machines live in this repo's `machines/`. Plugins, all
  of them, live here, never in an extending repo.
- **All of a machine's host state lives in `~/.local/state/vms/<name>/`**,
  so that `vm kill` removes it with a single `rm -rf`. Nothing may write
  outside it, except the shared `id_ed25519` keypair next to it.
- **Pin every external input.** That covers the Ubuntu image (URL + hash),
  the apt snapshot (bumped with the image), every `.deb` an Ubuntu machine
  installs (its `machines/<name>.lock.json`, from `vm lock` - re-run it when
  a machine's packages or the snapshot change, and the user tracks it), the
  Nix installer version, and the flake inputs. Snaps can't be pinned, so nothing may install one: keep
  snap-installing stub debs (like `firefox`) out with an apt preference.
- **`nix flake check` must pass, and must not build machines.** It only
  instantiates them. Keep `unsafeDiscardOutputDependency` in the
  `machines` check.
- **Test by booting.** Evaluation alone has missed real failures here
  (cloud-init runs `runcmd` without `$HOME`, for example). Run
  `vm up -d <name> && vm ssh <name> ... && vm kill <name>`.
- **The flake only sees tracked files once this is a git repo.** A new
  `machines/`/`plugins/` file is invisible to `vm up` until it is
  `git add`ed. The user does that, not the agent.
- **Host tooling belongs to the repo, not the guests.** `vm` is a Bun app
  on dev-tools (the `libs/dev-tools` submodule, a Bun workspace member) and
  follows dev-tools' app conventions: `src/run.ts` for scripted commands,
  lazily importing the dashboard, and every dashboard action reachable by
  click and hotkey. Nothing from it is ever installed into a VM.
