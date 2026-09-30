# Sway, the tiling Wayland compositor (i3's successor), logged straight in
# through greetd. foot is its terminal: Super+Enter. No lock screen or idle
# blanking unless configured - nothing to turn off.
{ ... }:
{
  imports = [ ./greetd.nix ];

  # A VM's virtual GPU has no hardware cursor plane.
  greetd.session = "env WLR_NO_HARDWARE_CURSORS=1 sway";

  # swaybg draws the default config's wallpaper - only recommended by sway,
  # which Alpine doesn't install, leaving the desktop black behind the bar.
  ubuntu.packages = [ "sway" "swaybg" "foot" ];
  debian.packages = [ "sway" "swaybg" "foot" ];
  alpine.packages = [ "sway" "swaybg" "foot" ];

  nixos.modules = [{
    programs.sway.enable = true;
  }];
}
