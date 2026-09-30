# XFCE, logged straight in (LightDM) - the light one, for a small machine.
# On Ubuntu the bare `xfce4`, without Xubuntu's applications or a screen
# locker.
{ config, ... }:
{
  imports = [ ./desktop.nix ];

  desktop.displayManager = "lightdm";

  ubuntu.packages = [ "xfce4" "lightdm" "lightdm-gtk-greeter" ];
  debian.packages = [ "xfce4" "lightdm" "lightdm-gtk-greeter" ];
  # Arch's `xfce4` is a group: its parts by name, as for GNOME.
  arch = {
    packages = [
      "xorg-server"
      "xfce4-session"
      "xfwm4"
      "xfce4-panel"
      "xfdesktop"
      "xfce4-settings"
      "thunar"
      "xfce4-terminal"
      "lightdm"
      "lightdm-gtk-greeter"
    ];
    # As on Alpine: LightDM's autologin PAM stack admits the `autologin` group.
    runcmd = [ [ "sh" "-c" "groupadd -rf autologin; gpasswd -a ${config.user} autologin" ] ];
  };
  alpine = {
    packages = [ "xfce4" "xfce4-terminal" "lightdm" "lightdm-gtk-greeter" ];
    # LightDM's autologin PAM stack admits the `autologin` group's members.
    runcmd = [ [ "sh" "-c" "addgroup -S autologin 2>/dev/null; addgroup ${config.user} autologin" ] ];
  };

  cloud = {
    writeFiles = [{
      path = "/etc/lightdm/lightdm.conf.d/50-vms-autologin.conf";
      content = ''
        [Seat:*]
        autologin-user=${config.user}
        autologin-session=xfce
      '';
    }];
  };

  nixos.modules = [{
    services.xserver.enable = true;
    services.xserver.desktopManager.xfce = {
      enable = true;
      # No lock screen: the user has no password (lib/options.nix).
      enableScreensaver = false;
    };
    services.xserver.displayManager.lightdm.enable = true;
    services.displayManager.defaultSession = "xfce";
    services.displayManager.autoLogin = {
      enable = true;
      inherit (config) user;
    };
  }];
}
