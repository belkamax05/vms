# direnv, hooked into zsh, with nix-direnv: a repo's .envrc (`use nix`,
# `use flake`) sets up its own tools on `cd`, cached instead of evaluated
# again every time. Brings no Nix of its own - on Ubuntu, pair it with the
# nix plugin; NixOS has it already.
#
#   direnv.trusted = [ "src" ];   # ~/src/**/.envrc runs without `direnv allow`
#
# For repos the machine clones itself (the repos plugin), where stopping at
# `direnv allow` in each one on every fresh VM would only be noise.
{ config, lib, pkgs, ... }:

let
  trusted = map (dir: "/home/${config.user}/${dir}") config.direnv.trusted;
in
{
  imports = [ ./zsh.nix ];

  options.direnv.trusted = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    default = [ ];
    description = "Folders under the user's home whose .envrc files are trusted without `direnv allow`.";
  };

  config = {
    cloud = {
      nixPackages = [ pkgs.direnv pkgs.nix-direnv ];
      # Config in /etc/direnv (DIRENV_CONFIG), like NixOS keeps it - not
      # ~/.config, which cloud-init would create as root's.
      writeFiles = [
        {
          path = "/etc/zshrc.d/direnv.zsh";
          content = ''
            export DIRENV_CONFIG=/etc/direnv
            eval "$(direnv hook zsh)"
          '';
        }
        {
          path = "/etc/direnv/direnvrc";
          content = ''
            source ${pkgs.nix-direnv}/share/nix-direnv/direnvrc
          '';
        }
        {
          path = "/etc/direnv/direnv.toml";
          content = ''
            [whitelist]
            prefix = [ ${lib.concatMapStringsSep ", " (dir: ''"${dir}"'') trusted} ]
          '';
        }
      ];
    };

    nixos.modules = [{
      programs.direnv = {
        enable = true;
        nix-direnv.enable = true;
        settings.whitelist.prefix = trusted;
      };
    }];
  };
}
