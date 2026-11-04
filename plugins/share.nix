# A folder shared with the host: the host's ~/vm-share is the guest user's
# ~/vm-share, both ways and live - drop a file in on either side and it is
# there on the other. One folder for every machine that has this, so it's
# also how machines pass files to each other. It's the user's folder, not
# machine state: `vm kill` leaves it alone.
#
# 9p (QEMU's -virtfs, no host daemon), mounted by the builder on every boot
# (lib/options.nix's `shares`). Linux guests only - Windows has no 9p.
{ config, ... }:
{
  shares.vmshare = {
    source = "$HOME/vm-share";
    target = "/home/${config.user}/vm-share";
  };
}
