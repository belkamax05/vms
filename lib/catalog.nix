# What a recipe (lib/recipe.nix) can be made of - the choices `vm new` offers,
# so machines are picked from parts instead of written one file per combination.
# A repo that extends this one adds its own entries (vms-dfs' catalog.nix):
# `extend` merges them in, theirs winning on a clash.
#
#   os.<id>        the base machine a recipe starts from; `family` (ubuntu,
#                  nixos) is what features' `os` and `requiresOn` name, so a
#                  feature needn't list every release
#   desktops.<id>  a desktop, with the OS families it runs on
#   features.<id>  a plugin (or any module) to toggle:
#                    group     the heading the wizard files it under
#                    requires  features switched on with it, on every OS
#                    requiresOn.<os>  ... on that OS only
#                    os        the OSes it runs on (all when unset)
#                    desktop   true: needs a desktop (a login to start from)
#                    default   true: on in a blank recipe
#                    builtinOn the OS families it's always on for - part of
#                              the system there, not a choice
#                  group "Environment" is shown with the tools, not with the
#                  other features: Nix and direnv are how tools arrive too
#   tools.<group>  nixpkgs attribute names the wizard suggests, grouped; any
#                  other name works too
#   defaultTools   the ones ticked in a blank recipe
#   toolOrder      the order the groups are shown in (attribute sets have
#                  none of their own); groups not in it come after
#   keyboards.<id> keyboard layouts (XKB names) - what typing produces; the
#                  interface stays English
#   presets.<id>   recipes to start from
#
# Everything but `module`/`base` is plain data: `info` is what `vm` reads.
{ lib }:

let
  catalog = {
    os = {
      ubuntu = { label = "Ubuntu 26.04"; family = "ubuntu"; base = ../machines/ubuntu.nix; };
      ubuntu-lts = {
        label = "Ubuntu 24.04 LTS";
        family = "ubuntu";
        base = { imports = [ ../machines/ubuntu.nix ]; ubuntu.release = "24.04"; };
      };
      debian = { label = "Debian 13"; family = "debian"; base = ../machines/debian.nix; };
      fedora = { label = "Fedora 44"; family = "fedora"; base = ../machines/fedora.nix; };
      rocky = { label = "Rocky Linux 10.2"; family = "rocky"; base = ../machines/rocky.nix; };
      alma = { label = "AlmaLinux 10.2"; family = "alma"; base = ../machines/alma.nix; };
      opensuse = { label = "openSUSE Leap 16.0"; family = "opensuse"; base = ../machines/opensuse.nix; };
      arch = { label = "Arch Linux"; family = "arch"; base = ../machines/arch.nix; };
      alpine = { label = "Alpine 3.24"; family = "alpine"; base = ../machines/alpine.nix; };
      nixos = { label = "NixOS 26.05"; family = "nixos"; base = ../machines/nixos.nix; };
      nixos-unstable = {
        label = "NixOS unstable";
        family = "nixos";
        base = { imports = [ ../machines/nixos.nix ]; nixos.channel = "unstable"; };
      };
    };

    desktops = {
      gnome = { label = "GNOME"; module = ../plugins/gui.nix; os = [ "ubuntu" "debian" "arch" "alpine" "nixos" ]; default = true; };
      kde = { label = "KDE Plasma"; module = ../plugins/kde.nix; os = [ "ubuntu" "debian" "arch" "alpine" "nixos" ]; };
      xfce = { label = "XFCE"; module = ../plugins/xfce.nix; os = [ "ubuntu" "debian" "arch" "alpine" "nixos" ]; };
      cinnamon = { label = "Cinnamon"; module = ../plugins/cinnamon.nix; os = [ "ubuntu" "nixos" ]; };
      cosmic = { label = "COSMIC"; module = ../plugins/cosmic.nix; os = [ "nixos" ]; };
      sway = { label = "Sway"; module = ../plugins/sway.nix; os = [ "ubuntu" "debian" "alpine" "nixos" ]; };
      hyprland = { label = "Hyprland"; module = ../plugins/hyprland.nix; os = [ "ubuntu" "alpine" "nixos" ]; };
      lxqt = { label = "LXQt"; module = ../plugins/lxqt.nix; os = [ "ubuntu" "debian" "alpine" "nixos" ]; };
      mate = { label = "MATE"; module = ../plugins/mate.nix; os = [ "ubuntu" "debian" "alpine" "nixos" ]; };
      budgie = { label = "Budgie"; module = ../plugins/budgie.nix; os = [ "ubuntu" "debian" "nixos" ]; };
      pantheon = { label = "Pantheon"; module = ../plugins/pantheon.nix; os = [ "nixos" ]; };
      steam = { label = "Steam (gaming mode)"; module = ../plugins/steam.nix; os = [ "nixos" ]; };
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
      starship = {
        label = "Starship";
        description = "the prompt, hooked into zsh";
        group = "Shell";
        module = ../plugins/starship.nix;
        requires = [ "zsh" ];
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
        description = "the Nix package manager, flakes on";
        group = "Environment";
        module = ../plugins/nix.nix;
        default = true;
        builtinOn = [ "nixos" ];
        # Not Alpine: OpenRC, and the official installer's daemon mode needs
        # systemd. Not the SELinux distros (Fedora, Rocky, Alma, openSUSE):
        # the installer refuses SELinux outright.
        os = [ "ubuntu" "debian" "arch" "nixos" ];
      };
      direnv = {
        label = "direnv";
        description = "each repo's .envrc sets its tools up on cd (nix-direnv)";
        group = "Environment";
        module = ../plugins/direnv.nix;
        requires = [ "zsh" ];
        # Where Nix can be installed and isn't the system itself; elsewhere
        # direnv runs without it, for .envrc files that don't `use nix`.
        requiresOn = lib.genAttrs [ "ubuntu" "debian" "arch" ] (_: [ "nix" ]);
        default = true;
      };
    };

    # General dev tools - nothing tied to one person or company.
    tools = {
      "Editors & git" = [ "neovim" "lazygit" "delta" "gh" "meld" ];
      "Search & files" = [ "ripgrep" "fd" "fzf" "bat" "lsd" "yazi" "ncdu" "ast-grep" "jq" ];
      "Languages & build" = [ "bun" "nodejs" "python3" "uv" "go" "rustup" "cmake" "ninja" "just" "mise" "biome" ];
      "Terminal" = [ "zellij" "tmux" "gum" "glow" "hyperfine" "shellcheck" "pandoc" ];
      "System" = [ "htop" "btop" "fastfetch" ];
      "AI" = [ "codex" ];
      "Desktop apps" = [ "firefox" ];
    };

    defaultTools = [ "bun" ];
    toolOrder = [ "Languages & build" "Editors & git" "Search & files" "Terminal" "System" "AI" "Desktop apps" ];

    # English first: a recipe without `keyboard` gets it.
    keyboards = {
      us = "English (US)";
      pt = "Portuguese";
      br = "Portuguese (Brazil)";
      gb = "English (UK)";
      es = "Spanish";
      de = "German";
      fr = "French";
      it = "Italian";
      pl = "Polish";
      ua = "Ukrainian";
    };

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
    tools = lib.zipAttrsWith (_: lists: lib.unique (lib.concatLists lists)) [ catalog.tools (extra.tools or { }) ];
    keyboards = catalog.keyboards // (extra.keyboards or { });
    defaultTools = lib.unique (catalog.defaultTools ++ (extra.defaultTools or [ ]));
    toolOrder = lib.unique (catalog.toolOrder ++ (extra.toolOrder or [ ]));
    presets = catalog.presets // (extra.presets or { });
  };

  info = c: {
    os = strip c.os;
    desktops = strip c.desktops;
    features = strip c.features;
    inherit (c) tools defaultTools toolOrder keyboards presets;
  };
}
