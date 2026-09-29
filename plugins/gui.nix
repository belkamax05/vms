# A desktop, logged straight in. GNOME on both OSes so the two are
# comparable - it's what stock Ubuntu Desktop is, and NixOS's module for it
# is the best-trodden one. On Ubuntu this is a first-boot apt install
# (~1.5 GB, several minutes); on NixOS it comes from the binary cache.
{ config, ... }:

{
  gui = true;
  memory = 8192;

  ubuntu = {
    packages = [ "ubuntu-desktop-minimal" ];
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
      # defer: written in cloud-init's final stage, after `packages` - gdm3's
      # own package ships custom.conf as a conffile, and writing it first
      # would stall dpkg on a conffile prompt.
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
      [ "systemctl" "set-default" "graphical.target" ]
      [ "systemctl" "start" "--no-block" "display-manager.service" ]
    ];
  };

  nixos.modules = [{
    services.displayManager.gdm.enable = true;
    services.desktopManager.gnome.enable = true;
    services.displayManager.autoLogin = {
      enable = true;
      inherit (config) user;
    };
  }];
}
