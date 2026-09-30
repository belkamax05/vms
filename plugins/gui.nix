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
in
{
  imports = [ ./desktop.nix ];

  ubuntu = {
    packages = [ "ubuntu-desktop-minimal" "dconf-cli" ];
    writeFiles = [
      # System defaults, applied by desktop.nix's `dconf update`.
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
