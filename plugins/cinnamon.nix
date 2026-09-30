# Cinnamon, logged straight in (LightDM) - Linux Mint's desktop. On Ubuntu
# the core `cinnamon` and its session, without the full environment's
# application suite.
{ config, lib, ... }:

let
  # No lock screen, no idle blanking: the user has no password
  # (lib/options.nix). Cinnamon keeps these in dconf, like GNOME.
  noLock = {
    settings = {
      "org/cinnamon/desktop/screensaver".lock-enabled = false;
      "org/cinnamon/desktop/session".idle-delay = lib.gvariant.mkUint32 0;
    };
    keyfile = ''
      [org/cinnamon/desktop/screensaver]
      lock-enabled=false

      [org/cinnamon/desktop/session]
      idle-delay=uint32 0
    '';
  };
in
{
  imports = [ ./desktop.nix ];

  ubuntu = {
    packages = [ "cinnamon" "cinnamon-session" "lightdm" "slick-greeter" "dconf-cli" ];
    writeFiles = [
      {
        path = "/etc/lightdm/lightdm.conf.d/50-vms-autologin.conf";
        content = ''
          [Seat:*]
          autologin-user=${config.user}
          autologin-session=cinnamon
        '';
      }
      # System defaults, applied by desktop.nix's `dconf update`.
      {
        path = "/etc/dconf/profile/user";
        content = ''
          user-db:user
          system-db:local
        '';
      }
      {
        path = "/etc/dconf/db/local.d/00-vms-no-lock";
        content = noLock.keyfile;
      }
    ];
  };

  nixos.modules = [{
    services.xserver.enable = true;
    services.xserver.desktopManager.cinnamon.enable = true;
    services.xserver.displayManager.lightdm.enable = true;
    services.displayManager.defaultSession = "cinnamon";
    services.displayManager.autoLogin = {
      enable = true;
      inherit (config) user;
    };
    programs.dconf.profiles.user.databases = [{ settings = noLock.settings; }];
  }];
}
