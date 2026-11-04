# Copy and paste between the host and a desktop machine, both ways (text and
# images), and files dragged onto its window - they land in the guest's
# ~/Downloads. SPICE has no file clipboard: copying a file on one side and
# pasting it on the other isn't something any QEMU display does; share.nix's
# ~/vm-share is the way for files.
#
# The window becomes a SPICE client (remote-viewer) instead of QEMU's GTK
# one, which has no clipboard; spice-vdagent in the guest is the other end.
# Its daemon is socket-activated on the systemd distros, and its session
# agent starts from /etc/xdg/autostart with the desktop.
{ ... }:
{
  clipboard = true;

  ubuntu.packages = [ "spice-vdagent" ];
  debian.packages = [ "spice-vdagent" ];
  arch.packages = [ "spice-vdagent" ];
  dnf.packages = [ "spice-vdagent" ];
  opensuse.packages = [ "spice-vdagent" ];
  alpine = {
    packages = [ "spice-vdagent" "spice-vdagent-openrc" ];
    runcmd = [ [ "sh" "-c" "rc-update add spice-vdagentd default; rc-service spice-vdagentd start" ] ];
  };

  nixos.modules = [{
    services.spice-vdagentd.enable = true;
  }];
}
