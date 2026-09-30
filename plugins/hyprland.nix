# Hyprland, the animated tiling Wayland compositor, logged straight in through
# greetd. kitty is its default config's terminal: Super+Q. Nothing locks
# unless configured.
{ ... }:
{
  imports = [ ./greetd.nix ];

  # A VM's virtual GPU has no hardware cursor plane.
  greetd.session = "env WLR_NO_HARDWARE_CURSORS=1 Hyprland";

  ubuntu.packages = [ "hyprland" "kitty" ];
  alpine.packages = [ "hyprland" "kitty" ];

  nixos.modules = [
    ({ pkgs, ... }: {
      programs.hyprland.enable = true;
      environment.systemPackages = [ pkgs.kitty ];
    })
  ];
}
