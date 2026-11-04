# machines/<name>.nix -> a runnable package. Every machine, whatever its
# OS, comes out with the same shape, which is all bin/vm relies on:
#
#   bin/vm-run   boots the machine; reads VM_STATE (its state dir),
#                VM_SSH_PORT (host port forwarded to guest :22),
#                VM_PUBKEY (public key to authorize for `user`) and
#                VM_USER_KEY (the machine's own keypair, vm-ssh - private
#                half, `.pub` beside it - installed as `user`'s
#                ~/.ssh/id_ed25519 on every boot)
#   meta         shell-sourceable facts about it (os, user, gui, the apt
#                packages `vm lock` resolves - none on NixOS -, the ISO it
#                downloads and hashes instead - Windows' -, and how long its
#                SSH may take to answer on a first boot)
{ nixpkgs, jovian, nixGL }:

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
  #   ready          the guest is done booting - on a first boot, done
  #                  provisioning: $VM_STATE/ready, which `vm` shows (the
  #                  runner contract's `ready` - see mkRunner's meta)
  hostRequests = {
    qemuArgs = "-device virtio-serial-pci,id=vmsserial -chardev file,id=vmshost,path=$VM_STATE/host-requests,append=on -device virtserialport,bus=vmsserial.0,chardev=vmshost,name=vms.host";
    start = ''
      : > "$VM_STATE/host-requests"
      rm -f "$VM_STATE/ready"
      tail -n 0 -F --pid=$$ "$VM_STATE/host-requests" 2>/dev/null | while read -r verb page; do
        if [ "$verb" = ready ]; then touch "$VM_STATE/ready"; continue; fi
        [ "$verb" = open ] || continue
        case $page in
          ssh-new) url=https://github.com/settings/ssh/new ;;
          keys) url=https://github.com/settings/keys ;;
          *) continue ;;
        esac
        xdg-open "$url" >/dev/null 2>&1 &
      done &
    '';
    # A guest shell command saying `word` on the port. By sysfs name rather
    # than /dev/virtio-ports/vms.host, which needs udev's rule: early in
    # boot (cloud-init's bootcmd) and on Alpine it may not be there yet.
    say = word: "modprobe virtio_console 2>/dev/null; for p in /sys/class/virtio-ports/*; do [ \"$(cat \"$p/name\" 2>/dev/null)\" = vms.host ] && echo ${word} > \"/dev/\${p##*/}\"; done; true";
    # For a guest that can't say it (Windows: no virtio drivers): ready once
    # sshd answers with its banner - QEMU's port forward accepts even with
    # nothing listening behind it, so a connection alone proves nothing.
    readyOnSsh = ''
      rm -f "$VM_STATE/ready"
      (
        # shellcheck disable=SC2016 # $1 is the inner shell's
        until [ "$(timeout 5 "$BASH" -c 'exec 3<>"/dev/tcp/127.0.0.1/$1"; head -c 4 <&3' _ "$VM_SSH_PORT" 2>/dev/null)" = SSH- ]; do
          kill -0 $$ 2>/dev/null || exit 0
          sleep 5
        done
        touch "$VM_STATE/ready"
      ) &
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

      # `image`: what it boots or installs from, downloaded into the Nix store
      # (a cloud image, Windows' ISO) - its path in meta, for `vm` to show.
      mkRunner = { script, runtimeInputs ? [ ], image ? null }:
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
          boot_timeout=${toString cfg.bootTimeout}
          ready=true
          image=${if image == null then "" else toString image}
          iso_url=${lib.escapeShellArg (if cfg.os == "windows" then cfg.windows.iso else "")}
          packages=${lib.escapeShellArg (lib.concatStringsSep " " (lib.unique (if aptPackages == null then [ ] else aptPackages)))}
          EOF
        '';

      # NixOS is built here; Windows installs itself from its ISO (unattended);
      # everything else boots its distro's cloud image.
      builder = { nixos = ./nixos.nix; windows = ./windows.nix; }.${cfg.os} or ./cloud.nix;

      # cfg.shares for the runner: the host folders made, and QEMU's 9p
      # devices for them. security_model=none: the guest's files are the
      # host user's, so both sides can edit them. Unquoted, to sit in
      # NixOS' QEMU_OPTS too: a source can't have spaces.
      shares = {
        setup = lib.concatMapStrings (s: "mkdir -p \"${s.source}\"\n") (lib.attrValues cfg.shares);
        qemuArgs = lib.concatStringsSep " " (lib.mapAttrsToList
          (tag: s: "-virtfs local,path=${s.source},mount_tag=${tag},security_model=none,id=${tag}")
          cfg.shares);
        # The guest's mount options, the same on every Linux guest.
        options = "trans=virtio,version=9p2000.L,msize=1048576";
      };

      # A gui machine's window: QEMU's GTK one, or with cfg.clipboard a SPICE
      # client. Then QEMU serves SPICE (GL: a local socket) with the vdagent
      # port - on hostRequests' virtio-serial bus, so its qemuArgs must come
      # first - and `start` opens remote-viewer on it once it's there.
      # Started by the runner, not QEMU's spice-app, which needs a desktop
      # handler for spice+unix:// registered on the host. Closing it powers
      # the machine off, as closing the GTK window does.
      window = {
        display = if cfg.clipboard then "none" else "gtk,gl=on";
        qemuArgs = lib.optionalString cfg.clipboard
          "-spice unix=on,addr=$VM_STATE/spice.sock,disable-ticketing=on,gl=on -chardev spicevmc,id=vdagent,name=vdagent -device virtserialport,bus=vmsserial.0,chardev=vdagent,name=com.redhat.spice.0";
        start = lib.optionalString cfg.clipboard ''
          rm -f "$VM_STATE/spice.sock"
          (
            until [ -S "$VM_STATE/spice.sock" ]; do
              kill -0 $$ 2>/dev/null || exit 0
              sleep 0.2
            done
            remote-viewer --title ${lib.escapeShellArg cfg.name} "spice+unix://$VM_STATE/spice.sock" >/dev/null 2>&1 || true
            if [ -s "$VM_STATE/qemu.pid" ]; then kill "$(cat "$VM_STATE/qemu.pid")" 2>/dev/null || true; fi
          ) &
        '';
        runtimeInputs = lib.optional cfg.clipboard pkgs.virt-viewer;
      };
    in
    import builder { inherit pkgs lib cfg mkRunner lockFile hostRequests shares window nixpkgs; };

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
  extendCatalogs = catalogLib.extendAll;
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
