# What every desktop plugin (gui.nix - GNOME -, kde.nix, xfce.nix,
# cinnamon.nix, cosmic.nix) shares: a window instead of a serial console, the
# memory a desktop needs, no snap stubs, and - on Ubuntu, where first boot's
# install is what brings a display manager - switching to it once it's there.
# Not a desktop by itself: import one of those. On Alpine, what Alpine's own
# setup-desktop does: Xorg, udev, D-Bus and elogind (seats and sessions
# without systemd), and the desktop's display manager (`desktop.displayManager`,
# which each desktop sets) enabled in OpenRC and started.
{ config, lib, ... }:
{
  options.desktop.displayManager = lib.mkOption {
    type = lib.types.str;
    description = "The display manager's OpenRC service (Alpine): gdm, sddm, lightdm.";
  };

  config = {
    gui = true;
    memory = 8192;

    alpine = {
      packages = [
        "xorg-server"
        "xf86-input-libinput"
        "mesa-dri-gallium"
        "eudev"
        "udev-init-scripts"
        "dbus"
        "elogind"
        "polkit-elogind"
        "font-dejavu"
      ];
      runcmd = [
        [
          "sh"
          "-c"
          (lib.concatStringsSep "; " [
            "if command -v dconf >/dev/null; then dconf update; fi"
            "for s in udev udev-trigger udev-settle; do rc-update add $s sysinit; done"
            "for s in dbus elogind ${config.desktop.displayManager}; do rc-update add $s default; done"
            "for s in udev udev-trigger udev-settle dbus elogind ${config.desktop.displayManager}; do rc-service $s start; done"
          ])
        ]
      ];
    };

    # Arch: nothing points display-manager.service at a display manager
    # until it's enabled, so enable it by name.
    arch.runcmd = [
      [
        "sh"
        "-c"
        (lib.concatStringsSep "; " [
          "if command -v dconf >/dev/null; then dconf update; fi"
          "systemctl enable ${config.desktop.displayManager}"
          "systemctl set-default graphical.target"
          "systemctl start --no-block ${config.desktop.displayManager}"
        ])
      ]
    ];

    # Debian: as Ubuntu - its packages make their display manager the
    # display-manager.service - without Ubuntu's snap stubs to keep out. But
    # the cloud image's kernel (-cloud-amd64) has no GPU drivers at all: no
    # /dev/dri, so no seat that can show a desktop. Debian's regular kernel
    # replaces it, and first boot reboots into it once - the steps still to
    # run are run again after (lib/cloud.nix's bootcmd), this one then a
    # no-op.
    debian.packages = [ "linux-image-amd64" ];
    debian.runcmd = [
      [
        "sh"
        "-c"
        (lib.concatStringsSep "; " [
          "uname -r | grep -q -- -cloud- || exit 0"
          "echo 'linux-base linux-base/removing-running-kernel boolean false' | debconf-set-selections"
          "dpkg-query -W -f '\${Package}\\n' 'linux-image-*cloud*' | xargs env DEBIAN_FRONTEND=noninteractive apt-get purge -y"
          "update-grub"
          "systemctl reboot"
        ])
      ]
      [ "sh" "-c" "if command -v dconf >/dev/null; then dconf update; fi" ]
      [ "systemctl" "set-default" "graphical.target" ]
      [ "systemctl" "start" "--no-block" "display-manager.service" ]
    ];

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
  };
}
