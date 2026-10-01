# Backlog

Open work on `vm`'s dashboard, picked up from the "per-machine busy state, booting spinner"
change (`5de3e6a`). Roughly in order: verify first, then the races that change opened up, then
polish.

## 1. Verify `5de3e6a` by booting (not done yet)

It was only typechecked, linted and unit-tested: the cloud session had no Nix/QEMU. On a real
host:

- [ ] `vm`, `[u]` on machine A, then while it builds: move to B and use `u`, `d`, `x`, `y`, `k`,
      `e`, `i`, `n` - they should all work; A's own buttons stay disabled.
- [ ] A's row shows the braille spinner instead of `○` and the hint `booting…`; it turns into `●`
      once QEMU is up.
- [ ] `[n]` mid-boot, cancel the wizard: A still shows the spinner, and `[u]` on A is still
      refused.
- [ ] Create & up from the wizard while another machine is booting - both boot.
- [ ] `s` / `c` / `l` / `g` are disabled (on every machine) while anything is working, and come
      back once it's done.

## 2. Races that concurrent actions now allow

Before `5de3e6a` only one action could run at a time, so these could not happen from the
dashboard (they always could from two terminals).

- [ ] **SSH port clash.** `prepare` (`apps/vm/src/core/machine/index.ts`) picks
      `firstFreePort()` by probing for a listener. Two `up`s finishing their builds close
      together can both pick the same port before either QEMU binds it. Fix: reserve the port in
      `<state>/ssh-port` and skip ports another machine's state dir already claims (running or
      mid-boot), or retry on QEMU's "could not set up host forwarding".
- [ ] **flake.lock written twice.** `relockPathInputs` runs `nix flake update` on the repo's
      flake.lock; two builds that both hit it race on the same file. Serialise it (a module-level
      promise/mutex in `core/machine`).
- [ ] **Status line is shared.** Two builds stream into the one `notify` line and overwrite each
      other. Give each machine its own last progress line (shown in its row hint or detail pane)
      and keep the shared line for finished/failed messages.

## 3. "Booting" should last until the guest answers

- [ ] The spinner stops when QEMU's pid appears (`upDetached` returns), but the guest is still
      booting until SSH answers (`[s]` then waits). Keep the machine in `booting` until an
      **async** SSH probe succeeds (`spawn`, not `spawnSync` like `waitSsh` - it would freeze
      the UI), giving up when the pid goes away. Then show `● :port`.
- [ ] Machines started elsewhere (`vm up -d` in another terminal) never show booting. Maybe the
      same probe on the refresh timer for running machines not yet seen answering.

## 4. Lift the "no handoff while working" restriction

- [ ] ssh / console / lock / Add to GitHub are disabled while any machine works, because
      `runTuiSession` (`libs/dev-tools/libs/ui/app/runTuiSession`) runs the handoff with
      `spawnSync`. That blocks the event loop: the in-flight build's piped output stalls, and
      when the dashboard reopens it's a fresh `App` that has lost the in-flight action. Options:
  - run builds/launches as a detached `vm up -d` child whose progress goes to
    `<state>/up.log` (inside the machine's state dir, per AGENTS.md), with the dashboard tailing
    it and reading "booting" from a marker file there - survives handoffs *and* quitting;
  - or make the handoff async in dev-tools and keep `App` mounted underneath.
- [ ] Same root cause: `[q]` during a build - check whether the nix build dies with the
      dashboard. Either ask first ("A is still building - quit anyway?") or detach as above.

## 5. Polish

- [ ] The spinner re-renders the whole dashboard 10×/s while anything boots, because a
      `PickItem.label` is a string. In dev-tools: let a `PickItem` take a leading glyph node (or
      a `spinning` flag) so only that cell re-renders, and move giti's `SpinnerGlyph` from
      `apps/giti/src/ui/dashboard/SpinnerGlyph` to `libs/ui/components` for both apps.
- [ ] Spinner (or another mark) for other in-flight actions too - power off, kill - instead
      of only the `working…` hint?

## 6. Cloud sessions / tooling

- [ ] `.gitmodules` points `libs/dev-tools` at `git@github.com:...`; a cloud session can't fetch
      that and needs `git -c url."https://github.com/".insteadOf="git@github.com:" submodule
      update --init`. Consider a SessionStart hook that does that plus `bun install`, so
      `bun run typecheck` works out of the box.
- [ ] The cloud container's Bun rewrites `bun.lock` on `bun install` (lockfileVersion 2 → 1,
      biome 2.5.14 → 2.5.15). Pin the Bun version (e.g. `packageManager` in `package.json`) so
      sessions don't produce lockfile churn.

## 7. Desktops on the RPM distros (left 2026-10-01)

Fedora, Rocky, AlmaLinux and openSUSE had no desktop choice in `vm new`. The
reason was that nothing had been built for them, not that something was
blocking it. The catalog's desktop `os` lists left them out, and the
`dnf`/`opensuse` halves could take only `packages`. They had no `writeFiles`
or `runcmd` for autologin config and for enabling a display manager.

### Done (uncommitted, in this working tree)

- `lib/options.nix`: `dnf` and `opensuse` are full `distroHalf`s (packages,
  writeFiles, runcmd), like Arch's.
- `lib/cloud.nix`: `dnfDistro` and `opensuse` pass those `writeFiles`/`runcmd`
  through instead of hardcoded `[ ]`.
- `plugins/desktop.nix`: Arch's "enable the display manager by name, set
  graphical.target, start it" is now `enableByName`, shared by `arch`, `dnf`
  and `opensuse`.
- `plugins/gui.nix` (GNOME): `dnf` and `opensuse` package lists plus
  `/etc/gdm/custom.conf` (autologin, `InitialSetupEnable=false`). The file is
  written before the install, so rpm keeps it and the package's own copy
  lands as `custom.conf.rpmnew`.
- `plugins/kde.nix`: `dnf` (Fedora) and `opensuse` package lists. The SDDM
  autologin and kscreenlocker files were already shared through
  `cloud.writeFiles`.
- `lib/catalog.nix`: GNOME is offered on fedora, rocky, alma and opensuse. KDE
  is offered on fedora and opensuse.
- `nix flake check` passes. All six test recipes evaluate.

Note: `lib/cloud.nix` and `lib/options.nix` were found already staged partway
through. The agent ran no git commands, so check the index before committing.

### Package availability, checked live in the guests' pinned repos

| | Fedora 44 (`fedora`) | Rocky/Alma 10.2 (BaseOS+AppStream) | openSUSE Leap 16 (`vms-oss`) |
| --- | --- | --- | --- |
| GNOME | yes | yes | yes |
| KDE Plasma | yes | **no**: EPEL only | yes (`plasma6-*`, `sddm-qt6`) |
| XFCE, LightDM | yes | no | yes |
| Cinnamon | yes | no | yes |
| MATE | yes | no | yes |
| LXQt | yes | no | not checked |
| Sway | yes | no | yes |
| Budgie | yes | no | not checked |
| virtio-gpu in cloud kernel | yes | yes | yes (despite `kernel-default-base`) |

### Boot tests

Test recipes are saved in `~/.config/vms/vms/recipes/t-*.json`. Run each with
`VMS_REPO=~/dfs/vms-dfs/libs/vms vm up -d <name>`, then poll for
`/var/lib/vms/provisioned` over `vm ssh`, then check `systemctl is-active
<dm>` and `loginctl list-sessions` (a `seat0` session for the user). Clean up
with `vm kill <name>`, which also removes its vm-ssh key from GitHub. Delete
the `t-*.json` files when done (`vm forget <name>`).

- [x] `t-fedora-gnome`: provisioned in about 6 min. gdm active,
      graphical.target, user logged in on seat0 (tty2), `/dev/dri/renderD128`
      present, gnome-initial-setup not installed.
- [ ] `t-alma-gnome`
- [ ] `t-rocky-gnome`
- [ ] `t-opensuse-gnome`: watch for gdm.service vs openSUSE's
      `display-manager` / `/etc/sysconfig/displaymanager` setup (Leap 16 had
      no `display-manager.service` on the raw image). Also check that
      `systemctl enable gdm` is enough and that autologin works.
- [ ] `t-fedora-kde`: check the Plasma session file name. kde.nix's SDDM
      autologin says `Session=plasma`, so make sure
      `/usr/share/wayland-sessions/plasma.desktop` exists.
- [ ] `t-opensuse-kde`: as above, with `sddm-qt6` (and check that `sddm.service`
      is the unit name).
- [ ] Look at each window by eye as well: a real desktop with no lock screen,
      and the dconf no-lock defaults applied (`gsettings get
      org.gnome.desktop.screensaver lock-enabled` should give `false`).
- [ ] Interrupted first boot: close the window mid-install, then `up` again.
      It should resume (bootcmd clears the retried steps; `recover` is empty
      for dnf and zypper, which may need a `rpm --rebuilddb` or a lock cleanup,
      so verify).
- [ ] SELinux (Fedora/Rocky/Alma): run `sudo ausearch -m avc -ts boot` after
      login. cloud-init writes `/etc/gdm/custom.conf` and the SDDM conf before
      the packages exist, so check that their labels are right
      (`ls -Z /etc/gdm/custom.conf`; fix with `restorecon` in runcmd if not).

### Next: more desktops on Fedora and openSUSE

Each one needs a `dnf`/`opensuse` half in its plugin, then the family added to
its `os` list in `lib/catalog.nix`. Look at the plugin's Arch half for the
shape: the plugin already sets `desktop.displayManager`, so `desktop.nix`
enables it.

- [ ] `xfce.nix`: Fedora `xfce4-session xfce4-panel xfdesktop xfwm4
      xfce4-terminal lightdm lightdm-gtk`. openSUSE: look up its LightDM
      greeter name. The autologin conf is in the plugin's other halves.
- [ ] `cinnamon.nix`: Fedora `cinnamon lightdm lightdm-gtk`, openSUSE
      `cinnamon`.
- [ ] `mate.nix`: Fedora `mate-session-manager` plus panel/wm/terminal. Look
      up openSUSE's names.
- [ ] `lxqt.nix`: Fedora `lxqt-session` and friends. openSUSE not checked.
- [ ] `sway.nix`: both have `sway`. Check how the plugin starts it (greetd?
      `plugins/greetd.nix`) and whether greetd is packaged on each.
- [ ] `budgie.nix`: Fedora `budgie-desktop`. openSUSE not checked.
- [ ] Hyprland: Fedora only via COPR (not pinned), so probably skip.

### Rocky / AlmaLinux beyond GNOME

They only enable the pinned BaseOS and AppStream, which contain GNOME and
nothing else. For KDE/XFCE/etc. there:

- [ ] Decide whether to pin EPEL. EPEL has no point-release snapshots the way
      the vault has, so pinning it the way vms requires ("pin every external
      input") needs a dated mirror or a snapshot service. If none exists, keep
      Rocky/Alma GNOME-only and say why in `lib/catalog.nix`.
- [ ] Either way, add a comment next to the desktops' `os` lists explaining
      why rocky/alma appear only under GNOME.

### Docs

- [ ] README's plugin table only has Ubuntu/NixOS columns. Mention that the
      desktops now also run on Fedora/openSUSE (and GNOME on Rocky/Alma), or
      switch the table to the catalog's per-desktop OS lists.
- [ ] `lib/options.nix`'s comment on `cloud` says "Ubuntu, Arch and Alpine
      alike". Bring it up to date (every cloud-image guest).
- [ ] Once committed and pushed to vms `master`, bump the `libs/vms`
      submodule in vms-dfs (see vms-dfs AGENTS.md). vms-dfs inherits the
      catalog, so its wizard gets these desktops too.
