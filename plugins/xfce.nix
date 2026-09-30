# XFCE, logged straight in (LightDM) - the light one, for a small machine.
# On Ubuntu the bare `xfce4`, without Xubuntu's applications or a screen
# locker.
{ config, ... }:
{
  imports = [ ./desktop.nix ];

  ubuntu = {
    packages = [ "xfce4" "lightdm" "lightdm-gtk-greeter" ];
    writeFiles = [{
      path = "/etc/lightdm/lightdm.conf.d/50-vms-autologin.conf";
      content = ''
        [Seat:*]
        autologin-user=${config.user}
        autologin-session=xfce
      '';
    }];
  };

  nixos.modules = [{
    services.xserver.enable = true;
    services.xserver.desktopManager.xfce = {
      enable = true;
      # No lock screen: the user has no password (lib/options.nix).
      enableScreensaver = false;
    };
    services.xserver.displayManager.lightdm.enable = true;
    services.displayManager.defaultSession = "xfce";
    services.displayManager.autoLogin = {
      enable = true;
      inherit (config) user;
    };
  }];
}
