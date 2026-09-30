# MATE, GNOME 2's continuation, logged straight in (LightDM).
{ lib, ... }:

let
  # No lock screen, no idle blanking: the user has no password
  # (lib/options.nix). MATE keeps these in dconf.
  noLock = {
    settings = {
      "org/mate/screensaver" = {
        lock-enabled = false;
        idle-activation-enabled = false;
      };
    };
    keyfile = ''
      [org/mate/screensaver]
      lock-enabled=false
      idle-activation-enabled=false
    '';
  };
in
{
  imports = [ ./lightdm.nix ];

  lightdm.session = "mate";

  # System defaults, applied by desktop.nix's `dconf update`.
  cloud.writeFiles = [
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

  ubuntu.packages = [ "mate-desktop-environment-core" "dconf-cli" ];
  debian.packages = [ "mate-desktop-environment-core" "dconf-cli" ];
  alpine.packages = [ "mate-desktop-environment" "dconf" ];

  nixos.modules = [{
    services.xserver.desktopManager.mate.enable = true;
    programs.dconf.profiles.user.databases = [{ inherit (noLock) settings; }];
  }];
}
