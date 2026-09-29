# NixOS guest: NixOS's own VM runner (virtualisation/qemu-vm.nix, what
# `nixos-rebuild build-vm` uses). It boots the built system straight from
# the host's /nix/store over 9p - no image to build or download - with a
# qcow2 for everything the guest writes. The base below is the minimum to
# log in; anything more comes from plugins' `nixos.modules`.
{ pkgs, lib, cfg, nixpkgs, mkRunner, ... }:

let
  system = nixpkgs.lib.nixosSystem {
    inherit (pkgs.stdenv.hostPlatform) system;
    modules = [
      "${nixpkgs}/nixos/modules/virtualisation/qemu-vm.nix"
      {
        system.stateVersion = "26.05";
        networking.hostName = cfg.name;

        virtualisation = {
          cores = cfg.cpus;
          memorySize = cfg.memory;
          diskSize = cfg.diskSize;
          graphics = cfg.gui;
          qemu.options = lib.optionals cfg.gui [
            "-vga none"
            "-device virtio-vga-gl"
            "-display gtk,gl=on"
          ];
        };

        users.users.${cfg.user} = {
          isNormalUser = true;
          extraGroups = [ "wheel" ];
        };
        security.sudo.wheelNeedsPassword = false;
        services.getty.autologinUser = cfg.user;

        # The runner hands this host's `vm` public key in over QEMU's fw_cfg
        # (see the -fw_cfg in the script below) - read at boot rather than
        # built in, since it belongs to the host, not to this repo.
        boot.kernelModules = [ "qemu_fw_cfg" ];
        services.openssh = {
          enable = true;
          settings.PasswordAuthentication = false;
          authorizedKeysFiles = [ "/run/vms/authorized_keys" ];
        };
        systemd.services.vms-authorized-keys = {
          wantedBy = [ "sshd.service" ];
          before = [ "sshd.service" ];
          serviceConfig.Type = "oneshot";
          script = ''
            install -d -m 755 /run/vms
            install -m 644 /sys/firmware/qemu_fw_cfg/by_name/opt/vms/authorized_keys/raw /run/vms/authorized_keys
          '';
        };
      }
    ] ++ cfg.nixos.modules;
  };

  vm = system.config.system.build.vm;
in
mkRunner {
  # NIX_DISK_IMAGE, QEMU_NET_OPTS and QEMU_OPTS are the runner's own
  # documented overrides; it creates the disk itself on first boot.
  script = ''
    export NIX_DISK_IMAGE="$VM_STATE/disk.qcow2"
    export QEMU_NET_OPTS="hostfwd=tcp:127.0.0.1:$VM_SSH_PORT-:22"
    export QEMU_OPTS="-pidfile $VM_STATE/qemu.pid -fw_cfg name=opt/vms/authorized_keys,file=$VM_PUBKEY"
    cd "$VM_STATE"
    exec ${vm}/bin/run-${cfg.name}-vm
  '';
}
