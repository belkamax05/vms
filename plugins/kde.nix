# KDE Plasma, logged straight in (SDDM). On Ubuntu the plain
# `kde-plasma-desktop` - Plasma without Kubuntu's application suite.
{ config, ... }:

let
  # No lock screen: the user has no password (lib/options.nix).
  noLock = ''
    [Daemon]
    Autolock=false
    LockOnResume=false
  '';
in
{
  imports = [ ./desktop.nix ];

  ubuntu = {
    packages = [ "kde-plasma-desktop" ];
    writeFiles = [
      {
        path = "/etc/sddm.conf.d/vms-autologin.conf";
        content = ''
          [Autologin]
          User=${config.user}
          Session=plasma
        '';
      }
      {
        path = "/etc/xdg/kscreenlockerrc";
        content = noLock;
      }
    ];
  };

  nixos.modules = [{
    services.desktopManager.plasma6.enable = true;
    services.displayManager.sddm = {
      enable = true;
      wayland.enable = true;
    };
    services.displayManager.defaultSession = "plasma";
    services.displayManager.autoLogin = {
      enable = true;
      inherit (config) user;
    };
    environment.etc."xdg/kscreenlockerrc".text = noLock;
  }];
}
