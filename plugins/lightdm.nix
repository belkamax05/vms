# LightDM, logging the user straight into `lightdm.session` - the display
# manager for the desktops that use it (lxqt.nix, mate.nix, budgie.nix), which
# set the session's name: its .desktop file in /usr/share/xsessions.
{ config, lib, ... }:

let
  inherit (config.lightdm) session;
  greeter = [ "lightdm" "lightdm-gtk-greeter" ];
in
{
  imports = [ ./desktop.nix ];

  options.lightdm.session = lib.mkOption {
    type = lib.types.str;
    description = "The X session LightDM logs the user into: lxqt, mate, budgie-desktop.";
  };

  config = {
    desktop.displayManager = "lightdm";

    cloud.writeFiles = [{
      path = "/etc/lightdm/lightdm.conf.d/50-vms-autologin.conf";
      content = ''
        [Seat:*]
        autologin-user=${config.user}
        autologin-session=${session}
      '';
    }];

    ubuntu.packages = greeter;
    debian.packages = greeter;
    alpine = {
      packages = greeter;
      # Alpine's LightDM autologin PAM stack admits the `autologin` group.
      runcmd = [ [ "sh" "-c" "addgroup -S autologin 2>/dev/null; addgroup ${config.user} autologin" ] ];
    };

    nixos.modules = [{
      services.xserver.enable = true;
      services.xserver.displayManager.lightdm.enable = true;
      services.displayManager.defaultSession = session;
      services.displayManager.autoLogin = {
        enable = true;
        inherit (config) user;
      };
    }];
  };
}
