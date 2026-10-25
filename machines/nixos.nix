# Minimal NixOS (nixos-unstable, flake.lock's pin) - a user, SSH, Nix with flakes on.
{
  imports = [ ../plugins/nix.nix ];
  os = "nixos";
}
