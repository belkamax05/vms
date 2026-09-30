# LXQt, the light Qt desktop, logged straight in (LightDM). No screen locker
# in its core set - nothing to turn off.
{ ... }:
{
  imports = [ ./lightdm.nix ];

  lightdm.session = "lxqt";

  ubuntu.packages = [ "lxqt-core" ];
  debian.packages = [ "lxqt-core" ];
  alpine.packages = [ "lxqt-desktop" ];

  nixos.modules = [{
    services.xserver.desktopManager.lxqt.enable = true;
  }];
}
