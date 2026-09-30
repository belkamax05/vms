{
  description = "Throwaway VMs - raw Ubuntu / NixOS guests, optional plugins on top";

  inputs = {
    # Same release as ~/dotfiles' pins, so the NixOS guests and the host's
    # own profile share one binary cache's worth of store paths.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    # For NixOS machines with `nixos.channel = "unstable"` only - pinned in
    # flake.lock like everything else, and fetched only when one is built.
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixGL = {
      url = "github:nix-community/nixGL";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nixpkgs-unstable, nixGL }:
    let
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
      vmsLib = import ./lib { inherit nixpkgs nixpkgs-unstable nixGL; };
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
      lib = {
        inherit (vmsLib) mkMachine mkMachines mkMachinesCheck mkRecipeMachine mkRecipes;
        inherit (vmsLib) catalog extendCatalog catalogInfo;
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
