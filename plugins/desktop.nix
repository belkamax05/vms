# What every desktop plugin (gui.nix - GNOME -, kde.nix, xfce.nix,
# cinnamon.nix, cosmic.nix) shares: a window instead of a serial console, the
# memory a desktop needs, no snap stubs, and - on Ubuntu, where first boot's
# install is what brings a display manager - switching to it once it's there.
# Not a desktop by itself: import one of those.
{ ... }:
{
  gui = true;
  memory = 8192;

  ubuntu = {
    # Ubuntu's `firefox` deb is only a stub that runs `snap install
    # firefox`, and snaps come from the live Snap Store - no revision to
    # pin, unlike apt (lib/ubuntu.nix's snapshot). Desktops only recommend
    # it, so forbidding it keeps the install reproducible and the desktop
    # whole. Written before `packages` runs.
    writeFiles = [{
      path = "/etc/apt/preferences.d/vms-no-snap-stubs";
      content = ''
        Package: firefox
        Pin: version *
        Pin-Priority: -1
      '';
    }];
    # The cloud image boots to multi-user.target; the desktop only arrives
    # with first boot's install, so switch target and start it in place
    # instead of needing a reboot. dconf: the desktops that keep settings
    # there (GNOME, Cinnamon) write their system defaults before this.
    runcmd = [
      [ "sh" "-c" "if command -v dconf >/dev/null; then dconf update; fi" ]
      [ "systemctl" "set-default" "graphical.target" ]
      [ "systemctl" "start" "--no-block" "display-manager.service" ]
    ];
  };
}
