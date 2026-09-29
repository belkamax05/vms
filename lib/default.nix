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

  # Guest -> host requests: a virtio-serial port, /dev/virtio-ports/vms.host
  # in the guest (root-only there - a plugin writes it with sudo), whose
  # output lands in $VM_STATE/host-requests. `start` follows that file for
  # as long as the runner's process lives (QEMU, once it execs) and does
  # what a line asks - only ever from the list below, so a guest can open
  # these pages in the host's browser and nothing else:
  #
  #   open ssh-new   GitHub's "add SSH key" page
  #   open keys      GitHub's SSH keys, where a key is authorized for SSO
  hostRequests = {
    qemuArgs = "-device virtio-serial-pci,id=vmsserial -chardev file,id=vmshost,path=$VM_STATE/host-requests,append=on -device virtserialport,bus=vmsserial.0,chardev=vmshost,name=vms.host";
    start = ''
      : > "$VM_STATE/host-requests"
      tail -n 0 -F --pid=$$ "$VM_STATE/host-requests" 2>/dev/null | while read -r verb page; do
        [ "$verb" = open ] || continue
        case $page in
          ssh-new) url=https://github.com/settings/ssh/new ;;
          keys) url=https://github.com/settings/keys ;;
          *) continue ;;
        esac
        xdg-open "$url" >/dev/null 2>&1 &
      done &
    '';
  };
in
rec {
  # machines/<name>.nix -> a runner package. `file` may live in any repo
  # that uses this one (see mkMachines); `vms` is this repo's root, handed
  # to every machine and plugin so one can import this repo's machines and
  # plugins by path: `imports = [ (vms + "/machines/ubuntu-gui.nix") ];`.
  # `pkgs` is this repo's pinned nixpkgs, for `ubuntu.nixPackages`.
  mkMachine = name: file:
    let
      cfg = (lib.evalModules {
        modules = [ ./options.nix file { inherit name; } ];
        specialArgs = { vms = ../.; inherit pkgs; };
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
    import builder { inherit pkgs lib cfg mkRunner nixpkgs lockFile hostRequests; };

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
