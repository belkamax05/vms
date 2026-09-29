# zoxide (`z <part of a path>`), hooked into zsh.
{ pkgs, ... }:
{
  imports = [ ./zsh.nix ];

  ubuntu = {
    nixPackages = [ pkgs.zoxide ];
    writeFiles = [{
      path = "/etc/zshrc.d/zoxide.zsh";
      content = ''
        eval "$(zoxide init zsh)"
      '';
    }];
  };

  nixos.modules = [{
    programs.zoxide.enable = true;
  }];
}
