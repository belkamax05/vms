# A desktop, logged straight in. GNOME on both OSes so the two are
# comparable - it's what stock Ubuntu Desktop is, and NixOS's module for it
# is the best-trodden one. On Ubuntu this is a first-boot apt install
# (~1.5 GB, several minutes); on NixOS it comes from the binary cache.
{ config, lib, ... }:

let
  # The same three GNOME settings for both OSes: lock screen off, idle
  # blanking (which locks) off.
  noLock = {
    settings = {
      "org/gnome/desktop/screensaver".lock-enabled = false;
      "org/gnome/desktop/lockdown".disable-lock-screen = true;
      "org/gnome/desktop/session".idle-delay = lib.gvariant.mkUint32 0;
    };
    keyfile = ''
      [org/gnome/desktop/screensaver]
      lock-enabled=false

      [org/gnome/desktop/lockdown]
      disable-lock-screen=true

      [org/gnome/desktop/session]
      idle-delay=uint32 0
    '';
  };
in
{
  gui = true;
  memory = 8192;

  ubuntu = {
    packages = [ "ubuntu-desktop-minimal" "dconf-cli" ];
    writeFiles = [
      # Ubuntu's `firefox` deb is only a stub that runs `snap install
      # firefox`, and snaps come from the live Snap Store - no revision to
      # pin, unlike apt (lib/ubuntu.nix's snapshot). The desktop only
      # recommends it, so forbidding it keeps the install reproducible and
      # the desktop whole. Written before `packages` runs.
      {
        path = "/etc/apt/preferences.d/vms-no-snap-stubs";
        content = ''
          Package: firefox
          Pin: version *
          Pin-Priority: -1
        '';
      }
      # No lock screen, no idle blanking: the user has no password (see
      # lib/options.nix), so a locked session could never be unlocked.
      # System defaults, applied by `dconf update` in runcmd below.
      {
        path = "/etc/dconf/profile/user";
        defer = true;
        content = ''
          user-db:user
          system-db:local
        '';
      }
      {
        path = "/etc/dconf/db/local.d/00-vms-no-lock";
        defer = true;
        content = ''
          ${noLock.keyfile}
        '';
      }
      # defer: written in cloud-init's final stage, once the user exists.
      # That's before the install (lib/ubuntu.nix runs it from runcmd), and
      # gdm3 ships custom.conf as a conffile - the install's --force-confold
      # keeps this one instead of stopping at a conffile prompt.
      {
        path = "/etc/gdm3/custom.conf";
        defer = true;
        content = ''
          [daemon]
          AutomaticLoginEnable=true
          AutomaticLogin=${config.user}
        '';
      }
    ];
    # The cloud image boots to multi-user.target; the desktop only arrives
    # after first boot's install, so switch target and start it in place
    # instead of needing a reboot.
    runcmd = [
      [ "dconf" "update" ]
      [ "systemctl" "set-default" "graphical.target" ]
      [ "systemctl" "start" "--no-block" "display-manager.service" ]
    ];
  };

  nixos.modules = [{
    programs.dconf.profiles.user.databases = [{ settings = noLock.settings; }];
    services.displayManager.gdm.enable = true;
    services.desktopManager.gnome.enable = true;
    services.displayManager.autoLogin = {
      enable = true;
      inherit (config) user;
    };
  }];
}
