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

  desktop.displayManager = "sddm";

  ubuntu.packages = [ "kde-plasma-desktop" ];
  debian.packages = [ "kde-plasma-desktop" "sddm" ];
  arch.packages = [ "plasma-desktop" "sddm" "konsole" ];
  alpine.packages = [ "plasma-desktop" "sddm" "konsole" ];

  # The same on every distro.
  cloud = {
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
