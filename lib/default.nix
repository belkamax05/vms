# machines/<name>.nix -> a runnable package. Every machine, whatever its
# OS, comes out with the same shape, which is all bin/vm relies on:
#
#   bin/vm-run   boots the machine; reads VM_STATE (its state dir),
#                VM_SSH_PORT (host port forwarded to guest :22),
#                VM_PUBKEY (public key to authorize for `user`) and
#                VM_USER_KEY (the machine's own keypair, vm-ssh - private
#                half, `.pub` beside it - installed as `user`'s
#                ~/.ssh/id_ed25519 on every boot)
#   meta         shell-sourceable facts about it (os, user, gui, and the
#                apt packages `vm lock` resolves - none on NixOS)
{ nixpkgs, nixGL }:

let
  inherit (nixpkgs) lib;
  pkgs = nixpkgs.legacyPackages.x86_64-linux;

  # GUI machines render through virgl, which needs the host's OpenGL - and a
  # Nix-built QEMU can't see Ubuntu's own Mesa. nixGLIntel is nixGL's plain
  # Mesa wrapper (it covers AMD too, despite the name) and, unlike nixGL's
  # auto-detecting default, evaluates without --impure.
  nixGLMesa = nixGL.packages.x86_64-linux.nixGLIntel;
in
rec {
  # machines/<name>.nix -> a runner package. `file` may live in any repo
  # that uses this one (see mkMachines); `vms` is this repo's root, handed
  # to every machine and plugin so one can import this repo's machines and
  # plugins by path: `imports = [ (vms + "/machines/ubuntu-gui.nix") ];`.
  mkMachine = name: file:
    let
      cfg = (lib.evalModules {
        modules = [ ./options.nix file { inherit name; } ];
        specialArgs.vms = ../.;
      }).config;

      # Next to the machine's own file, so a repo that adds machines keeps
      # their lockfiles too - `vm lock` writes it there.
      lockFile = dirOf file + "/${name}.lock.json";

      mkRunner = { script, runtimeInputs ? [ ] }:
        let
          run = pkgs.writeShellApplication {
            name = "vm-run-${name}";
            inherit runtimeInputs;
            text = script;
          };
        in
        pkgs.runCommand "vm-${name}" { passthru = { inherit cfg; }; } ''
          mkdir -p $out/bin
          ${if cfg.gui then ''
            cat > $out/bin/vm-run <<EOF
            #!${pkgs.runtimeShell}
            exec ${nixGLMesa}/bin/nixGLIntel ${run}/bin/vm-run-${name} "\$@"
            EOF
            chmod +x $out/bin/vm-run
          '' else ''
            ln -s ${run}/bin/vm-run-${name} $out/bin/vm-run
          ''}
          cat > $out/meta <<EOF
          os=${cfg.os}
          user=${cfg.user}
          gui=${lib.boolToString cfg.gui}
          packages=${lib.escapeShellArg (lib.concatStringsSep " " (lib.unique cfg.ubuntu.packages))}
          EOF
        '';

      builder = { ubuntu = ./ubuntu.nix; nixos = ./nixos.nix; }.${cfg.os};
    in
    import builder { inherit pkgs lib cfg mkRunner nixpkgs lockFile; };

  # A directory of machines/<name>.nix -> { <name> = package; }, no registry
  # to edit. This repo's own flake and any repo extending it call this on
  # their own machines/ directory.
  mkMachines = dir: lib.mapAttrs'
    (file: _: lib.nameValuePair (lib.removeSuffix ".nix" file)
      (mkMachine (lib.removeSuffix ".nix" file) (dir + "/${file}")))
    (lib.filterAttrs (file: type: type == "regular" && lib.hasSuffix ".nix" file)
      (builtins.readDir dir));

  # `nix flake check` for a set of machines: every one evaluates, none is
  # built (building them all would download the Ubuntu image and a GNOME
  # closure). unsafeDiscardOutputDependency: depend on the .drv only - a
  # plain drvPath would pull in its outputs, i.e. build every machine.
  mkMachinesCheck = machines: pkgs.writeText "machines"
    (lib.concatMapStringsSep "\n"
      (m: builtins.unsafeDiscardOutputDependency m.drvPath)
      (lib.attrValues machines));
}
