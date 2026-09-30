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
{ nixpkgs, nixpkgs-unstable, jovian, nixGL }:

let
  inherit (nixpkgs) lib;
  pkgs = nixpkgs.legacyPackages.x86_64-linux;

  # GUI machines render through virgl, which needs the host's OpenGL - and a
  # Nix-built QEMU can't see Ubuntu's own Mesa. nixGLIntel is nixGL's plain
  # Mesa wrapper (it covers AMD too, despite the name) and, unlike nixGL's
  # auto-detecting default, evaluates without --impure.
  nixGLMesa = nixGL.packages.x86_64-linux.nixGLIntel;

  catalogLib = import ./catalog.nix { inherit lib; };
  recipeModule = import ./recipe.nix { inherit lib; };

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
  mkMachine = name: file: mkMachineFrom { inherit name; module = file; dir = dirOf file; };

  # The machine behind both mkMachine and mkRecipeMachine: `module` is what
  # it is, `dir` where its lockfile lives - next to its own file, so a repo
  # that adds machines keeps their lockfiles too (`vm lock` writes it there).
  mkMachineFrom = { name, module, dir }:
    let
      cfg = (lib.evalModules {
        modules = [ ./options.nix module { inherit name; } ];
        specialArgs = { vms = ../.; inherit pkgs; jovianModule = jovian.nixosModules.default; };
      }).config;

      lockFile = dir + "/${name}.lock.json";

      # The apt guests' packages - what `vm lock` locks; null elsewhere.
      aptPackages = { ubuntu = cfg.ubuntu.packages; debian = cfg.debian.packages; }.${cfg.os} or null;

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
          github_user=${lib.escapeShellArg (if cfg.github.user == null then "" else cfg.github.user)}
          apt=${lib.boolToString (aptPackages != null)}
          packages=${lib.escapeShellArg (lib.concatStringsSep " " (lib.unique (if aptPackages == null then [ ] else aptPackages)))}
          EOF
        '';

      # NixOS is built here; everything else boots its distro's cloud image.
      builder = if cfg.os == "nixos" then ./nixos.nix else ./cloud.nix;
    in
    import builder {
      inherit pkgs lib cfg mkRunner lockFile hostRequests;
      # The NixOS builder's system comes from the machine's channel.
      nixpkgs = if cfg.nixos.channel == "unstable" then nixpkgs-unstable else nixpkgs;
    };

  # A directory of machines/<name>.nix -> { <name> = package; }, no registry
  # to edit. This repo's own flake and any repo extending it call this on
  # their own machines/ directory.
  mkMachines = dir: lib.mapAttrs'
    (file: _: lib.nameValuePair (lib.removeSuffix ".nix" file)
      (mkMachine (lib.removeSuffix ".nix" file) (dir + "/${file}")))
    (lib.filterAttrs (file: type: type == "regular" && lib.hasSuffix ".nix" file)
      (builtins.readDir dir));

  # The catalog recipes are made from (lib/catalog.nix), with `extend` for a
  # repo that adds its own entries, and `info` - plain data - for `vm`.
  catalog = catalogLib.catalog;
  extendCatalog = catalogLib.extend;
  catalogInfo = catalogLib.info;

  # A recipe file (JSON, lib/recipe.nix) -> a runner, like mkMachine. `file`
  # may be anywhere - `vm new` keeps its recipes out of the repo, in
  # ~/.config/vms, and builds them with --impure - and its lockfile sits
  # next to it.
  mkRecipeMachine = catalog: name: file: mkMachineFrom {
    inherit name;
    module = recipeModule catalog (builtins.fromJSON (builtins.readFile file));
    dir = dirOf file;
  };

  # A repo's recipes/<name>.json -> { <name> = package; }, like mkMachines:
  # recipes checked in, next to their lockfiles.
  mkRecipes = catalog: dir:
    if !builtins.pathExists dir then { }
    else lib.mapAttrs'
      (file: _: lib.nameValuePair (lib.removeSuffix ".json" file)
        (mkRecipeMachine catalog (lib.removeSuffix ".json" file) (dir + "/${file}")))
      (lib.filterAttrs (file: type: type == "regular" && lib.hasSuffix ".json" file && !lib.hasSuffix ".lock.json" file)
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
