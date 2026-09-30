# Budgie, Solus' desktop on GNOME's stack, logged straight in (LightDM).
{ lib, ... }:

let
  # No lock screen, no idle blanking: the user has no password
  # (lib/options.nix). Budgie's screensaver reads GNOME's keys.
  noLock = {
    settings = {
      "org/gnome/desktop/screensaver".lock-enabled = false;
      "org/gnome/desktop/session".idle-delay = lib.gvariant.mkUint32 0;
    };
    keyfile = ''
      [org/gnome/desktop/screensaver]
      lock-enabled=false

      [org/gnome/desktop/session]
      idle-delay=uint32 0
    '';
  };
in
{
  imports = [ ./lightdm.nix ];

  lightdm.session = "budgie-desktop";

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

  ubuntu.packages = [ "budgie-desktop" "dconf-cli" ];
  debian.packages = [ "budgie-desktop" "dconf-cli" ];

  nixos.modules = [{
    services.desktopManager.budgie.enable = true;
    programs.dconf.profiles.user.databases = [{ inherit (noLock) settings; }];
  }];
}
