# zoxide (`z <part of a path>`) installed. `z` itself comes from the zsh
# plugin, which sets it up wherever zoxide is on PATH - so a repo that brings
# zoxide through direnv gets `z` too, without this plugin.
{ pkgs, ... }:
{
  imports = [ ./zsh.nix ];

  ubuntu.nixPackages = [ pkgs.zoxide ];

  nixos.modules = [{
    programs.zoxide.enable = true;
  }];
}
