# The keyboard layout: what typing produces - not the interface's language,
# which stays English. `keyboard.layout` is an XKB layout name (us, pt, br,
# ...); lib/catalog.nix's `keyboards` lists the ones the wizard offers.
#
# Set in every place a desktop might read it from, since they differ: the
# system's own (/etc/default/keyboard: the console, localed, and X for XFCE
# and Cinnamon), GNOME's input sources in dconf, and KDE's kxkbrc. A place no
# desktop reads costs nothing. All files, written before first boot's
# commands run - so before any display manager starts.
{ config, lib, ... }:

let
  inherit (config.keyboard) layout;
in
{
  options.keyboard.layout = lib.mkOption {
    type = lib.types.str;
    default = "us";
    description = "XKB layout name: us, pt (Portugal), br (Brazil), gb, de, ...";
  };

  config = {
    ubuntu = {
      writeFiles = [
        # A conffile of keyboard-configuration, already in the cloud image:
        # the install's --force-confold keeps this one.
        {
          path = "/etc/default/keyboard";
          content = ''
            XKBMODEL="pc105"
            XKBLAYOUT="${layout}"
            XKBVARIANT=""
            XKBOPTIONS=""
            BACKSPACE="guess"
          '';
        }
        # GNOME - applied by desktop.nix's `dconf update`, with the profile
        # gui.nix writes.
        {
          path = "/etc/dconf/db/local.d/00-vms-keyboard";
          content = ''
            [org/gnome/desktop/input-sources]
            sources=[('xkb', '${layout}')]
          '';
        }
        {
          path = "/etc/xdg/kxkbrc";
          content = ''
            [Layout]
            LayoutList=${layout}
            Use=true
          '';
        }
      ];
    };

    nixos.modules = [{
      services.xserver.xkb.layout = layout;
      console.useXkbConfig = true;
    }];
  };
}
