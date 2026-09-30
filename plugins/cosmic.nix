# COSMIC, System76's Rust desktop, logged straight in - NixOS only: Ubuntu
# doesn't package it, so this plugin has no Ubuntu half (the catalog offers
# it for NixOS alone).
{ config, ... }:
{
  imports = [ ./desktop.nix ];

  nixos.modules = [{
    services.desktopManager.cosmic.enable = true;
    services.displayManager.cosmic-greeter.enable = true;
    services.displayManager.autoLogin = {
      enable = true;
      inherit (config) user;
    };
  }];
}
