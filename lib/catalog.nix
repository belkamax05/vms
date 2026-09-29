# What a recipe (lib/recipe.nix) can be made of - the choices `vm new` offers,
# so machines are picked from parts instead of written one file per combination.
# A repo that extends this one adds its own entries (vms-dfs' catalog.nix):
# `extend` merges them in, theirs winning on a clash.
#
#   os.<id>        the base machine a recipe starts from
#   desktops.<id>  a desktop, with the OSes it runs on
#   features.<id>  a plugin (or any module) to toggle:
#                    group     the heading the wizard files it under
#                    requires  features switched on with it, on every OS
#                    requiresOn.<os>  ... on that OS only
#                    os        the OSes it runs on (all when unset)
#                    desktop   true: needs a desktop (a login to start from)
#                    default   true: on in a blank recipe
#   tools          nixpkgs attribute names the wizard suggests; any other
#                  name works too
#   presets.<id>   recipes to start from
#
# Everything but `module`/`base` is plain data: `info` is what `vm` reads.
{ lib }:

let
  catalog = {
    os = {
      ubuntu = { label = "Ubuntu 26.04"; base = ../machines/ubuntu.nix; };
      nixos = { label = "NixOS 26.05"; base = ../machines/nixos.nix; };
    };

    desktops = {
      gnome = { label = "GNOME"; module = ../plugins/gui.nix; os = [ "ubuntu" "nixos" ]; };
    };

    features = {
      git = {
        label = "git";
        description = "nixpkgs' git, newer than Ubuntu's";
        group = "Shell";
        module = ../plugins/git.nix;
        default = true;
      };
      zsh = {
        label = "zsh";
        description = "as the login shell";
        group = "Shell";
        module = ../plugins/zsh.nix;
        default = true;
      };
      zoxide = {
        label = "zoxide";
        description = "`z <part of a path>`, hooked into zsh";
        group = "Shell";
        module = ../plugins/zoxide.nix;
        requires = [ "zsh" ];
      };
      nix = {
        label = "Nix";
        description = "the Nix package manager, flakes on (NixOS has it anyway)";
        group = "Environment";
        module = ../plugins/nix.nix;
      };
      direnv = {
        label = "direnv";
        description = "each repo's .envrc sets its tools up on cd (nix-direnv)";
        group = "Environment";
        module = ../plugins/direnv.nix;
        requires = [ "zsh" ];
        requiresOn.ubuntu = [ "nix" ];
      };
    };

    tools = [ "bun" "lazygit" "nodejs" "ripgrep" "fd" "jq" "fzf" "htop" "neovim" "gh" ];

    presets = { };
  };

  # Only what `vm` shows: no module or base paths, which would drag the
  # plugins' store paths into a JSON dump.
  strip = lib.mapAttrs (_: entry: removeAttrs entry [ "module" "base" ]);
in
{
  inherit catalog;

  extend = extra: {
    os = catalog.os // (extra.os or { });
    desktops = catalog.desktops // (extra.desktops or { });
    features = catalog.features // (extra.features or { });
    tools = lib.unique (catalog.tools ++ (extra.tools or [ ]));
    presets = catalog.presets // (extra.presets or { });
  };

  info = c: {
    os = strip c.os;
    desktops = strip c.desktops;
    features = strip c.features;
    inherit (c) tools presets;
  };
}
