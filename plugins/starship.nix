# Starship, the prompt, hooked into zsh (after the zsh plugin's own plain
# PROMPT, so it wins).
{ pkgs, ... }:
{
  imports = [ ./zsh.nix ];

  ubuntu = {
    nixPackages = [ pkgs.starship ];
    writeFiles = [{
      path = "/etc/zshrc.d/starship.zsh";
      content = ''
        eval "$(starship init zsh)"
      '';
    }];
  };

  nixos.modules = [{
    programs.starship.enable = true;
  }];
}
