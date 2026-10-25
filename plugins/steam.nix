# Steam's gaming mode - the Steam Deck's interface (Gamescope) - booted
# straight into, through Jovian-NixOS, as SteamOS does; its desktop (Plasma)
# is one switch away in Steam's power menu. NixOS only, on the nixos-unstable
# every machine is built from, which Jovian follows. Steam is
# proprietary: allowed here for Steam's own packages alone. A VM has no real
# GPU, so games run slowly if at all - it's for the interface, not play.
{ config, jovianModule, ... }:
{
  imports = [ ./desktop.nix ];

  desktop.displayManager = "greetd";

  nixos.modules = [
    jovianModule
    ({ lib, ... }: {
      jovian.steam = {
        enable = true;
        autoStart = true;
        inherit (config) user;
        desktopSession = "plasma";
      };
      services.desktopManager.plasma6.enable = true;
      nixpkgs.config.allowUnfreePredicate = pkg: lib.hasPrefix "steam" (lib.getName pkg);
    })
  ];
}
