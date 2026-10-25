{
  description = "Throwaway VMs - raw Ubuntu / NixOS guests, optional plugins on top";

  inputs = {
    # nixos-unstable, as ~/dotfiles' own nixpkgs: current tools (bun, ...) in
    # every guest, and NixOS guests sharing store paths with the host's
    # profile. Pinned in flake.lock - `nix flake update nixpkgs` moves it.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Steam's gaming mode for NixOS (plugins/steam.nix), on the same nixpkgs -
    # fetched only when a machine uses it.
    jovian = {
      url = "github:Jovian-Experiments/Jovian-NixOS";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixGL = {
      url = "github:nix-community/nixGL";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, jovian, nixGL }:
    let
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
      vmsLib = import ./lib { inherit nixpkgs jovian nixGL; };
      machines = vmsLib.mkMachines ./machines // vmsLib.mkRecipes vmsLib.catalog ./recipes;
    in
    {
      # For repos that extend this one (e.g. vms-dfs, with this repo as a
      # submodule): `packages = vms.lib.mkMachines ./machines;` builds their
      # own machines/ the same way, and their machines import this repo's
      # machines and plugins through the `vms` module argument.
      # recipeMachine and catalogInfo are what `vm` calls: a recipe from
      # anywhere (--impure) built against this repo's catalog, and that
      # catalog as data. An extending repo exposes its own, from its catalog.
      # mkMachine, mkRecipeMachine and extendCatalogs are also how `vm` builds
      # the machines of ~/.config/vms/repos.d folders, which have no flake.
      lib = {
        inherit (vmsLib) mkMachine mkMachines mkMachinesCheck mkRecipeMachine mkRecipes;
        inherit (vmsLib) catalog extendCatalog extendCatalogs catalogInfo;
        recipeMachine = vmsLib.mkRecipeMachine vmsLib.catalog;
        info = vmsLib.catalogInfo vmsLib.catalog;
      };

      packages.x86_64-linux = machines;

      # `nix flake check`: every machine evaluates (see mkMachinesCheck),
      # and bin/vm lints.
      checks.x86_64-linux = {
        machines = vmsLib.mkMachinesCheck machines;
        shellcheck = pkgs.runCommand "shellcheck" { } ''
          ${pkgs.shellcheck}/bin/shellcheck ${./bin/vm}
          touch $out
        '';
      };
    };
}
