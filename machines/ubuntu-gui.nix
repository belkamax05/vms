# machines/ubuntu.nix plus the stock GNOME desktop, logged straight in.
{
  imports = [ ./ubuntu.nix ../plugins/gui.nix ];
}
