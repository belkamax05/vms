# Pantheon, elementary OS' desktop, logged straight in - NixOS only: no other
# distro here packages it. Its NixOS module brings its own LightDM greeter.
{ config, ... }:
{
  imports = [ ./desktop.nix ];

  desktop.displayManager = "lightdm";

  nixos.modules = [{
    services.desktopManager.pantheon.enable = true;
    services.displayManager.defaultSession = "pantheon";
    services.displayManager.autoLogin = {
      enable = true;
      inherit (config) user;
    };
  }];
}
