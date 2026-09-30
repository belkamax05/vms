# Nix inside the guest, with flakes on. Ubuntu doesn't have it at all
# until this runs; NixOS always has Nix, so there it only turns flakes on.
#
# The Ubuntu install is the official multi-user installer, pinned to a
# release rather than nixos.org/nix/install (which always serves the
# latest), so a machine gets the same Nix until this line is bumped.
{ ... }:

let
  version = "2.35.2";
in
{
  # What the official installer needs to fetch and unpack itself.
  ubuntu.packages = [ "curl" "xz-utils" ];
  arch.packages = [ "curl" "xz" ];

  # Ubuntu and Arch - Alpine has no systemd for the daemon install, so the
  # catalog doesn't offer Nix there.
  cloud = {
    # Not written to /etc/nix/nix.conf directly: the installer writes that
    # file itself and would replace it. It appends this one instead.
    writeFiles = [{
      path = "/var/lib/vms/nix-extra.conf";
      content = ''
        experimental-features = nix-command flakes
      '';
    }];
    # HOME: cloud-init's runcmd runs without it, and the installer refuses
    # to start unset.
    runcmd = [
      "export HOME=/root; curl -fsSL https://releases.nixos.org/nix/nix-${version}/install | sh -s -- --daemon --yes --nix-extra-conf-file /var/lib/vms/nix-extra.conf"
    ];
  };

  nixos.modules = [{
    nix.settings.experimental-features = [ "nix-command" "flakes" ];
  }];
}
