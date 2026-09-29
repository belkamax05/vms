# machines/nixos.nix plus GNOME, logged straight in.
{
  imports = [ ./nixos.nix ../plugins/gui.nix ];
}
