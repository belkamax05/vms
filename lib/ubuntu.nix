# Ubuntu guest: the stock cloud image, untouched, plus a cloud-init NoCloud
# seed generated from the machine's config. Nothing here installs anything
# into the image itself - "raw Ubuntu" is exactly what Canonical ships, and
# every change on top of it is a cloud-init entry a plugin chose to add.
#
# The image is pinned by URL + hash (a dated release directory, not
# .../release/, which moves). What apt installs on top of it is pinned the
# Nix way: `vm lock <name>` resolves the machine's packages once, against
# the live archive, and records every .deb with its sha256 in
# machines/<name>.lock.json; the build fetches each by that hash into the
# store and indexes them into a local repo, and the guest installs from that
# repo alone. The same lockfile gives the same bytes on every device, with
# no archive involved after the first fetch. The image's store path is only
# ever a read-only qcow2 backing file - each VM writes to its own overlay in
# its state dir.
{ pkgs, lib, cfg, mkRunner, lockFile, ... }:

let
  # Where the .debs are fetched from: the archive's pool first, and Ubuntu's
  # snapshot of the archive at the moment `vm lock` ran as the fallback - a
  # file superseded since may be pruned from the pool, never from the
  # snapshot, and pool files never change once published.
  aptPool = "http://archive.ubuntu.com/ubuntu";
  aptSnapshot = "https://snapshot.ubuntu.com/ubuntu/${lock.snapshot}";

  image = pkgs.fetchurl {
    url = "https://cloud-images.ubuntu.com/releases/26.04/release-20260918/ubuntu-26.04-server-cloudimg-amd64.img";
    sha256 = "4908fb59ccd4e87ae4e8e973b7ef56f535448eacb24a87fd787270c0048987bc";
  };

  packages = lib.unique cfg.ubuntu.packages;

  # machines/<name>.lock.json, next to the machine's file (see
  # lib/default.nix), written by `vm lock`: the packages it was resolved
  # for, and every .deb that takes on top of the image.
  lock = if builtins.pathExists lockFile then builtins.fromJSON (builtins.readFile lockFile) else null;
  lockProblem =
    if packages == [ ] then null
    else if lock == null then "has no machines/${cfg.name}.lock.json"
    else if lib.sort lib.lessThan lock.packages != lib.sort lib.lessThan packages
    then "machines/${cfg.name}.lock.json was resolved for other packages"
    else null;

  debRepo = pkgs.runCommand "${cfg.name}-debs" { nativeBuildInputs = [ pkgs.dpkg ]; } ''
    mkdir -p $out
    ${lib.concatMapStrings (deb: ''
      ln -s ${pkgs.fetchurl ({
        urls = [ "${aptPool}/${deb.path}" "${aptSnapshot}/${deb.path}" ];
      } // lib.getAttrs (lib.intersectLists [ "sha256" "sha512" ] (lib.attrNames deb)) deb)} $out/${deb.file}
    '') (lib.optionals (lockProblem == null && lock != null) lock.debs)}
    cd $out && dpkg-scanpackages --multiversion . /dev/null > Packages
  '';

  autologin = unit: {
    path = "/etc/systemd/system/${unit}.d/autologin.conf";
    content = ''
      [Service]
      ExecStart=
      ExecStart=-/sbin/agetty --autologin ${cfg.user} --noclear --keep-baud %I 115200,38400,9600 $TERM
    '';
  };

  # The machine's own keypair (vm-ssh), substituted by the runner like the
  # authorized key - it's host state, never in the store. Deferred to the
  # final stage: the user, and the ~/.ssh cloud-init makes for its
  # authorized_keys, don't exist yet when write_files normally runs.
  userKey = [
    {
      path = "/home/${cfg.user}/.ssh/id_ed25519";
      encoding = "b64";
      content = "@USER_KEY_B64@";
      owner = "${cfg.user}:${cfg.user}";
      permissions = "0600";
      defer = true;
    }
    {
      path = "/home/${cfg.user}/.ssh/id_ed25519.pub";
      content = "@USER_PUBKEY@\n";
      owner = "${cfg.user}:${cfg.user}";
      permissions = "0644";
      defer = true;
    }
  ];

  # apt pointed at the runner's repo only (@DEBS_URL@, the host as QEMU's
  # user network sees it), with lists of its own - the guest's regular
  # sources, the image's stock ones, stay as they are for whatever you
  # install by hand later.
  localApt = lib.concatStringsSep " " [
    "-o Dir::Etc::SourceList=/etc/vms/apt/local.list"
    "-o Dir::Etc::SourceParts=/etc/vms/apt/empty.d"
    "-o Dir::State::Lists=/var/lib/vms/apt-lists"
  ];
  installPackages = [
    "sh" "-c"
    (lib.concatStringsSep " && " [
      "mkdir -p /etc/vms/apt/empty.d /var/lib/vms/apt-lists/partial"
      "echo 'deb [trusted=yes] @DEBS_URL@ ./' > /etc/vms/apt/local.list"
      "apt-get ${localApt} update"
      "DEBIAN_FRONTEND=noninteractive apt-get ${localApt} -o Dpkg::Options::=--force-confold install -y ${lib.escapeShellArgs packages}"
    ])
  ];

  provisioned = "/var/lib/vms/provisioned";
  # The first-boot steps that install and configure: deferred files, and
  # runcmd (written by `runcmd`, run by `scripts_user`).
  retried = [ "write_files_deferred" "runcmd" "scripts_user" ];

  base = {
    hostname = cfg.name;
    users = [{
      name = cfg.user;
      groups = [ "sudo" ];
      shell = "/bin/bash";
      sudo = "ALL=(ALL) NOPASSWD:ALL";
      lock_passwd = true;
      # Substituted by the runner at boot - the key belongs to this host's
      # `vm` install, not to the repo, so it can't be baked in at build time.
      ssh_authorized_keys = [ "@SSH_PUBKEY@" ];
    }];
    ssh_pwauth = false;
  };

  cloudConfig = lib.recursiveUpdate (base // {
    write_files = [
      (autologin "serial-getty@ttyS0.service")
      (autologin "getty@tty1.service")
    ] ++ userKey ++ cfg.ubuntu.writeFiles;
    # cloud-init marks a step done when it *starts* it, so a first boot cut
    # short (the window closed mid-install) would leave apt half-done and
    # the plugins' commands never run, on every later boot. Until the last
    # step below has run, each boot finishes what dpkg was doing and clears
    # those steps' marks first - bootcmd runs before any of them - so the
    # same boot does them again.
    bootcmd = [
      "[ -e ${provisioned} ] || { dpkg --configure -a; rm -f ${lib.concatMapStringsSep " " (m: "/var/lib/cloud/instance/sem/config_${m}") retried}; }"
    ];
    runcmd = [
      [ "systemctl" "daemon-reload" ]
      [ "systemctl" "restart" "serial-getty@ttyS0.service" "getty@tty1.service" ]
    ] ++ lib.optional (packages != [ ]) installPackages ++ cfg.ubuntu.runcmd ++ [
      # Only once every package is really there: runcmd carries on past a
      # failed step, and a failed install must be retried next boot.
      [ "sh" "-c" "${lib.optionalString (packages != [ ]) "dpkg-query -W ${lib.escapeShellArgs packages} >/dev/null && "}mkdir -p ${dirOf provisioned} && touch ${provisioned}" ]
    ];
  }) cfg.ubuntu.cloudConfig;

  # What `vm lock` boots: the same user, and the files that land before
  # packages (apt preferences like the gui plugin's), but nothing installed -
  # so apt resolves against exactly the image the machine starts from.
  lockConfig = base // {
    write_files = lib.filter (f: !(f.defer or false)) cfg.ubuntu.writeFiles;
  };

  # JSON is valid YAML, so cloud-config needs no YAML generator.
  userData = pkgs.writeText "${cfg.name}-user-data"
    "#cloud-config\n${builtins.toJSON cloudConfig}\n";
  lockUserData = pkgs.writeText "${cfg.name}-lock-user-data"
    "#cloud-config\n${builtins.toJSON lockConfig}\n";

  # Stable for a given config, so a reboot doesn't re-run first-boot modules,
  # but new whenever the config changes - on an existing disk, cloud-init
  # then treats it as a new instance and applies the new config.
  instanceId = "${cfg.name}-${builtins.substring 0 12 (builtins.hashString "sha256" (toString userData))}";
in
mkRunner {
  # VM_LOCK=1 (`vm lock`) boots the lock configuration instead; the rest of
  # the contract is the same. The repo server lives as long as QEMU does.
  script = ''
    display=(${if cfg.gui
      then "-vga none -device virtio-vga-gl -display 'gtk,gl=on' -serial null"
      else "-nographic"})
    if [ "''${VM_LOCK:-0}" = 1 ]; then
      user_data=${lockUserData}
      display=(-nographic)
    else
      ${if lockProblem != null then ''
        echo "vm: ${cfg.name} ${lockProblem} - run: vm lock ${cfg.name}" >&2
        exit 1
      '' else "user_data=${userData}"}
    fi

    disk="$VM_STATE/disk.qcow2"
    if [ ! -e "$disk" ]; then
      qemu-img create -q -f qcow2 -F qcow2 -b ${image} "$disk" ${toString cfg.diskSize}M
    fi

    # The .debs, served on the host's loopback - which the guest reaches as
    # 10.0.2.2 on QEMU's user network, and nothing else can reach at all.
    python3 - ${debRepo} "$VM_STATE/debs-port" <<'PY' &
    import functools, http.server, sys
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=sys.argv[1])
    handler.func.log_message = lambda *args: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    open(sys.argv[2], "w").write(str(server.server_address[1]))
    server.serve_forever()
    PY
    server=$!
    trap 'kill "$server" 2>/dev/null' EXIT
    rm -f "$VM_STATE/debs-port"
    until [ -s "$VM_STATE/debs-port" ]; do sleep 0.1; done
    debs_url="http://10.0.2.2:$(cat "$VM_STATE/debs-port")/"

    mkdir -p "$VM_STATE/seed"
    pubkey="$(cat "$VM_PUBKEY")"
    userpub="$(cat "$VM_USER_KEY.pub")"
    userkey="$(base64 -w0 "$VM_USER_KEY")"
    sed -e "s|@SSH_PUBKEY@|$pubkey|" -e "s|@USER_PUBKEY@|$userpub|" -e "s|@USER_KEY_B64@|$userkey|" \
      -e "s|@DEBS_URL@|$debs_url|" "$user_data" > "$VM_STATE/seed/user-data"
    printf 'instance-id: %s\nlocal-hostname: %s\n' ${instanceId} ${cfg.name} > "$VM_STATE/seed/meta-data"
    rm -f "$VM_STATE/seed.iso"
    xorriso -as genisoimage -quiet -output "$VM_STATE/seed.iso" -volid cidata -joliet -rock \
      "$VM_STATE/seed/user-data" "$VM_STATE/seed/meta-data" 2>/dev/null

    qemu-system-x86_64 \
      -name ${cfg.name} -enable-kvm -machine q35 -cpu host \
      -smp ${toString cfg.cpus} -m ${toString cfg.memory} \
      -drive if=virtio,file="$disk" \
      -drive if=virtio,media=cdrom,readonly=on,file="$VM_STATE/seed.iso" \
      -netdev user,id=net0,hostfwd=tcp:127.0.0.1:"$VM_SSH_PORT"-:22 \
      -device virtio-net-pci,netdev=net0 \
      -device virtio-rng-pci \
      -pidfile "$VM_STATE/qemu.pid" \
      "''${display[@]}"
  '';
  runtimeInputs = [ pkgs.qemu pkgs.xorriso pkgs.gnused pkgs.coreutils pkgs.python3 ];
}
