{
  description = "Throwaway VMs - raw Ubuntu / NixOS guests, optional plugins on top";

  inputs = {
    # Same release as ~/dotfiles' pins, so the NixOS guests and the host's
    # own profile share one binary cache's worth of store paths.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    nixGL = {
      url = "github:nix-community/nixGL";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nixGL }:
    let
      inherit (nixpkgs) lib;
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
      vmLib = import ./lib { inherit nixpkgs nixGL; };

      # machines/<name>.nix -> packages.<name>, no registry to edit.
      machines = lib.mapAttrs'
        (file: _: lib.nameValuePair (lib.removeSuffix ".nix" file)
          (vmLib.mkMachine (lib.removeSuffix ".nix" file) (./machines + "/${file}")))
        (lib.filterAttrs (file: type: type == "regular" && lib.hasSuffix ".nix" file)
          (builtins.readDir ./machines));
    in
    {
      packages.x86_64-linux = machines;

      # `nix flake check`: every machine evaluates (building them all would
      # download the Ubuntu image and a GNOME closure), and bin/vm lints.
      checks.x86_64-linux = {
        machines = pkgs.writeText "machines"
          (lib.concatMapStringsSep "\n"
            # unsafeDiscardOutputDependency: depend on the .drv only - a plain
            # drvPath would pull in its outputs, i.e. build every machine.
            (m: builtins.unsafeDiscardOutputDependency m.drvPath)
            (lib.attrValues machines));
        shellcheck = pkgs.runCommand "shellcheck" { } ''
          ${pkgs.shellcheck}/bin/shellcheck ${./bin/vm}
          touch $out
        '';
      };
    };
}
