# Ubuntu guest: the stock cloud image, untouched, plus a cloud-init NoCloud
# seed generated from the machine's config. Nothing here installs anything
# into the image itself - "raw Ubuntu" is exactly what Canonical ships, and
# every change on top of it is a cloud-init entry a plugin chose to add.
#
# The image is pinned by URL + hash (a dated release directory, not
# .../release/, which moves), so a machine boots the same base everywhere
# until someone bumps it here. Its store path is only ever a read-only
# qcow2 backing file - each VM writes to its own overlay in its state dir.
{ pkgs, lib, cfg, mkRunner, ... }:

let
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
    write_files = [
      (autologin "serial-getty@ttyS0.service")
      (autologin "getty@tty1.service")
    ] ++ cfg.ubuntu.writeFiles;
    runcmd = [
      [ "systemctl" "daemon-reload" ]
      [ "systemctl" "restart" "serial-getty@ttyS0.service" "getty@tty1.service" ]
    ] ++ cfg.ubuntu.runcmd;
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
    sed "s|@SSH_PUBKEY@|$pubkey|" ${userData} > "$VM_STATE/seed/user-data"
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
  runtimeInputs = [ pkgs.qemu pkgs.xorriso pkgs.gnused ];
}
