# Ubuntu guest: the stock cloud image, untouched, plus a cloud-init NoCloud
# seed generated from the machine's config. Nothing here installs anything
# into the image itself - "raw Ubuntu" is exactly what Canonical ships, and
# every change on top of it is a cloud-init entry a plugin chose to add.
#
# The image is pinned by URL + hash (a dated release directory, not
# .../release/, which moves), and apt by a snapshot of the archive from the
# same day, so a machine boots - and installs - the same everywhere until
# someone bumps both here. Its store path is only ever a read-only
# qcow2 backing file - each VM writes to its own overlay in its state dir.
{ pkgs, lib, cfg, mkRunner, ... }:

let
  # Everything apt installs (every plugin's `packages`, the desktop's ~1000)
  # comes from Ubuntu's snapshot archive as it stood at this moment - the
  # image's own release day - not the live archive, which would give each
  # device, each month, other versions. Bump it with the image. Security
  # updates stop at the same moment, until it's bumped.
  aptSnapshot = "https://snapshot.ubuntu.com/ubuntu/20260918T000000Z";

  image = pkgs.fetchurl {
    url = "https://cloud-images.ubuntu.com/releases/26.04/release-20260918/ubuntu-26.04-server-cloudimg-amd64.img";
    sha256 = "4908fb59ccd4e87ae4e8e973b7ef56f535448eacb24a87fd787270c0048987bc";
  };

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

  provisioned = "/var/lib/vms/provisioned";
  # The first-boot steps that install and configure: packages, deferred
  # files, and runcmd (written by `runcmd`, run by `scripts_user`).
  retried = [ "package_update_upgrade_install" "write_files_deferred" "runcmd" "scripts_user" ];

  cloudConfig = lib.recursiveUpdate {
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
    apt = {
      primary = [{ arches = [ "default" ]; uri = aptSnapshot; }];
      security = [{ arches = [ "default" ]; uri = aptSnapshot; }];
    };
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
    ] ++ cfg.ubuntu.runcmd ++ [
      [ "sh" "-c" "mkdir -p ${dirOf provisioned} && touch ${provisioned}" ]
    ];
  } (lib.optionalAttrs (cfg.ubuntu.packages != [ ]) {
    package_update = true;
    packages = cfg.ubuntu.packages;
  } // cfg.ubuntu.cloudConfig);

  # JSON is valid YAML, so cloud-config needs no YAML generator.
  userData = pkgs.writeText "${cfg.name}-user-data"
    "#cloud-config\n${builtins.toJSON cloudConfig}\n";

  # Stable for a given config, so a reboot doesn't re-run first-boot modules,
  # but new whenever the config changes - on an existing disk, cloud-init
  # then treats it as a new instance and applies the new config.
  instanceId = "${cfg.name}-${builtins.substring 0 12 (builtins.hashString "sha256" (toString userData))}";
in
mkRunner {
  script = ''
    disk="$VM_STATE/disk.qcow2"
    if [ ! -e "$disk" ]; then
      qemu-img create -q -f qcow2 -F qcow2 -b ${image} "$disk" ${toString cfg.diskSize}M
    fi

    mkdir -p "$VM_STATE/seed"
    pubkey="$(cat "$VM_PUBKEY")"
    userpub="$(cat "$VM_USER_KEY.pub")"
    userkey="$(base64 -w0 "$VM_USER_KEY")"
    sed -e "s|@SSH_PUBKEY@|$pubkey|" -e "s|@USER_PUBKEY@|$userpub|" -e "s|@USER_KEY_B64@|$userkey|" \
      ${userData} > "$VM_STATE/seed/user-data"
    printf 'instance-id: %s\nlocal-hostname: %s\n' ${instanceId} ${cfg.name} > "$VM_STATE/seed/meta-data"
    rm -f "$VM_STATE/seed.iso"
    xorriso -as genisoimage -quiet -output "$VM_STATE/seed.iso" -volid cidata -joliet -rock \
      "$VM_STATE/seed/user-data" "$VM_STATE/seed/meta-data" 2>/dev/null

    exec qemu-system-x86_64 \
      -name ${cfg.name} -enable-kvm -machine q35 -cpu host \
      -smp ${toString cfg.cpus} -m ${toString cfg.memory} \
      -drive if=virtio,file="$disk" \
      -drive if=virtio,media=cdrom,readonly=on,file="$VM_STATE/seed.iso" \
      -netdev user,id=net0,hostfwd=tcp:127.0.0.1:"$VM_SSH_PORT"-:22 \
      -device virtio-net-pci,netdev=net0 \
      -device virtio-rng-pci \
      -pidfile "$VM_STATE/qemu.pid" \
      ${if cfg.gui
        then "-vga none -device virtio-vga-gl -display gtk,gl=on -serial null"
        else "-nographic"}
  '';
  runtimeInputs = [ pkgs.qemu pkgs.xorriso pkgs.gnused pkgs.coreutils ];
}
