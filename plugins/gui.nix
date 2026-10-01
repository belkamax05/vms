# GNOME, logged straight in - the same desktop on both OSes, so the two are
# comparable: it's what stock Ubuntu Desktop is, and NixOS's module for it is
# the best-trodden one. On Ubuntu this is a first-boot apt install (~1.5 GB,
# several minutes); on NixOS it comes from the binary cache. The other
# desktops sit beside it (kde.nix, xfce.nix, ...), on desktop.nix.
{ config, lib, ... }:

let
  # The same three GNOME settings for both OSes: lock screen off, idle
  # blanking (which locks) off - the user has no password (see
  # lib/options.nix), so a locked session could never be unlocked.
  noLock = {
    settings = {
      "org/gnome/desktop/screensaver".lock-enabled = false;
      "org/gnome/desktop/lockdown".disable-lock-screen = true;
      "org/gnome/desktop/session".idle-delay = lib.gvariant.mkUint32 0;
    };
    keyfile = ''
      [org/gnome/desktop/screensaver]
      lock-enabled=false

      [org/gnome/desktop/lockdown]
      disable-lock-screen=true

      [org/gnome/desktop/session]
      idle-delay=uint32 0
    '';
  };

  # /etc/gdm/custom.conf where GDM's package ships it as a config file - this
  # one is written first, and rpm keeps it (the package's lands as .rpmnew).
  gdmAutologin = {
    path = "/etc/gdm/custom.conf";
    content = ''
      [daemon]
      AutomaticLoginEnable=true
      AutomaticLogin=${config.user}
      InitialSetupEnable=false
    '';
  };
in
{
  imports = [ ./desktop.nix ];

  desktop.displayManager = "gdm";

  # System defaults, applied by desktop.nix's `dconf update` - the same on
  # every distro.
  cloud.writeFiles = [
      {
        path = "/etc/dconf/profile/user";
        defer = true;
        content = ''
          user-db:user
          system-db:local
        '';
      }
      {
        path = "/etc/dconf/db/local.d/00-vms-no-lock";
        defer = true;
        content = noLock.keyfile;
      }
  ];

  # Debian's GDM reads daemon.conf (Ubuntu's, custom.conf) - a conffile
  # either way, kept by the install's --force-confold.
  debian = {
    packages = [ "gnome-core" "gdm3" "dconf-cli" ];
    writeFiles = [{
      path = "/etc/gdm3/daemon.conf";
      defer = true;
      content = ''
        [daemon]
        AutomaticLoginEnable=true
        AutomaticLogin=${config.user}
      '';
    }];
  };

  # Arch's `gnome` is a group, not a package: its parts by name, so the
  # install can be checked for.
  arch = {
    packages = [ "gnome-shell" "gnome-session" "gdm" "gnome-control-center" "gnome-console" "nautilus" "dconf" ];
    writeFiles = [{
      path = "/etc/gdm/custom.conf";
      content = ''
        [daemon]
        AutomaticLoginEnable=true
        AutomaticLogin=${config.user}
      '';
    }];
  };

  # The RPM distros: GNOME's parts by name, as on Arch, rather than a group
  # (`installed` checks with rpm -q). Wayland only - Fedora and EL10 dropped
  # GNOME's X11 session. GDM would run gnome-initial-setup first, which
  # weak deps pull in: off, since the user is already made.
  dnf = {
    packages = [ "gdm" "gnome-shell" "gnome-session-wayland-session" "gnome-control-center" "ptyxis" "nautilus" "dconf" "mesa-dri-drivers" ];
    writeFiles = [ gdmAutologin ];
  };

  opensuse = {
    packages = [ "gdm" "gnome-shell" "gnome-session-wayland" "gnome-control-center" "ptyxis" "nautilus" "dconf" "Mesa-dri" ];
    writeFiles = [ gdmAutologin ];
  };

  alpine = {
    packages = [ "gnome" "gdm" "dconf" ];
    writeFiles = [{
      path = "/etc/gdm/custom.conf";
      content = ''
        [daemon]
        AutomaticLoginEnable=true
        AutomaticLogin=${config.user}
      '';
    }];
  };

  ubuntu = {
    packages = [ "ubuntu-desktop-minimal" "dconf-cli" ];
    writeFiles = [
      # defer: written in cloud-init's final stage, once the user exists.
      # That's before the install (lib/ubuntu.nix runs it from runcmd), and
      # gdm3 ships custom.conf as a conffile - the install's --force-confold
      # keeps this one instead of stopping at a conffile prompt.
      {
        path = "/etc/gdm3/custom.conf";
        defer = true;
        content = ''
          [daemon]
          AutomaticLoginEnable=true
          AutomaticLogin=${config.user}
        '';
      }
    ];
  };

  nixos.modules = [{
    programs.dconf.profiles.user.databases = [{ settings = noLock.settings; }];
    services.displayManager.gdm.enable = true;
    services.desktopManager.gnome.enable = true;
    services.displayManager.autoLogin = {
      enable = true;
      inherit (config) user;
    };
  }];
}
