# machines/<name>.nix -> a runnable package. Every machine, whatever its
# OS, comes out with the same shape, which is all bin/vm relies on:
#
#   bin/vm-run   boots the machine; reads VM_STATE (its state dir),
#                VM_SSH_PORT (host port forwarded to guest :22) and
#                VM_PUBKEY (public key to authorize for `user`)
#   meta         shell-sourceable facts about it (os, user, gui)
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
{
  mkMachine = name: file:
    let
      cfg = (lib.evalModules {
        modules = [ ./options.nix file { inherit name; } ];
      }).config;

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
          EOF
        '';

      builder = { ubuntu = ./ubuntu.nix; nixos = ./nixos.nix; }.${cfg.os};
    in
    import builder { inherit pkgs lib cfg mkRunner nixpkgs; };
}
