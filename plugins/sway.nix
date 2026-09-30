# Sway, the tiling Wayland compositor (i3's successor), logged straight in
# through greetd. foot is its terminal: Super+Enter. No lock screen or idle
# blanking unless configured - nothing to turn off.
{ ... }:
{
  imports = [ ./greetd.nix ];

  # A VM's virtual GPU has no hardware cursor plane.
  greetd.session = "env WLR_NO_HARDWARE_CURSORS=1 sway";

  ubuntu.packages = [ "sway" "foot" ];
  debian.packages = [ "sway" "foot" ];
  alpine.packages = [ "sway" "foot" ];

  nixos.modules = [{
    programs.sway.enable = true;
  }];
}
