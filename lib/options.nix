# The contract every machine and plugin is written against: one module
# system (lib.evalModules, same machinery as NixOS itself), so a machine is
# just a module that sets `os` plus a few sizes, and a plugin is just another
# module it imports. A plugin sets whichever OS-specific halves it supports -
# `ubuntu.*` (cloud-init fragments) and/or `nixos.modules` - and the builder
# for the machine's own `os` reads only its half, so one plugin file can serve
# both OSes without either one knowing about the other.
{ lib, ... }:

let
  inherit (lib) mkOption types;

  # A distro's own packages, files and commands - on that distro only.
  distroHalf = packages: distro: {
    packages = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = packages;
    };
    writeFiles = mkOption {
      type = types.listOf (types.attrsOf types.anything);
      default = [ ];
      description = "cloud-init write_files entries, on ${distro} only.";
    };
    runcmd = mkOption {
      type = types.listOf (types.either types.str (types.listOf types.str));
      default = [ ];
      description = "cloud-init runcmd entries, on ${distro} only.";
    };
  };
in
{
  options = {
    name = mkOption {
      type = types.str;
      description = "Machine name - set from machines/<name>.nix, doubles as the guest hostname.";
    };

    os = mkOption {
      type = types.enum [ "ubuntu" "debian" "fedora" "rocky" "alma" "opensuse" "arch" "alpine" "nixos" "windows" ];
    };

    bootTimeout = mkOption {
      type = types.ints.positive;
      default = 300;
      description = ''
        Seconds `vm ssh` waits for SSH to answer - long enough for a first
        boot's provisioning. Windows' unattended install sets an hour.
      '';
    };

    cpus = mkOption {
      type = types.ints.positive;
      default = 4;
    };

    memory = mkOption {
      type = types.ints.positive;
      default = 4096;
      description = "RAM in MiB.";
    };

    diskSize = mkOption {
      type = types.ints.positive;
      default = 20480;
      description = "Root disk in MiB. A thin qcow2 - only what the guest writes takes host space.";
    };

    user = mkOption {
      type = types.str;
      default = "maksym";
      description = ''
        The one login user: passwordless sudo, autologin on the console (and
        the desktop, with the gui plugin), SSH by the key `vm` generates. No
        password is ever set - the SSH port is bound to 127.0.0.1 only.
      '';
    };

    packages = mkOption {
      type = types.listOf types.package;
      default = [ ];
      description = ''
        Packages from this repo's pinned nixpkgs (the `pkgs` module
        argument), on either OS: `environment.systemPackages` on NixOS,
        `ubuntu.nixPackages` on Ubuntu. For a plain tool that needs no
        per-OS setup - anything that does keeps to the OS halves.
      '';
    };

    github.user = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = ''
        The GitHub account the machine's own key (vm-ssh) goes on - the one
        with access to what the guest clones. `vm` adds the key there through
        the host's gh on `up`, and removes it on `kill` and rotation; gh must
        be logged in as it, with the admin:public_key scope. Null: gh's
        active account.
      '';
    };

    gui = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Open a window with a virtio-gpu (virgl) display instead of attaching
        the serial console to the terminal. Set by plugins/gui.nix, not by
        hand - a display without a desktop to put on it is just a login prompt.
      '';
    };

    ubuntu = {
      release = mkOption {
        type = types.enum [ "26.04" "24.04" ];
        default = "26.04";
        description = "Which Ubuntu - each has its own pinned cloud image (lib/ubuntu.nix).";
      };
      packages = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = "apt packages, installed by cloud-init on first boot.";
      };
      nixPackages = mkOption {
        type = types.listOf types.package;
        default = [ ];
        description = ''
          Packages from this repo's pinned nixpkgs (the `pkgs` module
          argument), for when Ubuntu's own are too old. Built on the host
          and copied into the guest's /nix/store on first boot, before
          `runcmd`, with their binaries linked into /usr/local/bin, which
          comes before apt's /usr/bin on PATH. The guest doesn't need Nix.
        '';
      };
      runcmd = mkOption {
        type = types.listOf (types.either types.str (types.listOf types.str));
        default = [ ];
        description = "cloud-init runcmd entries - run once, as root, on first boot, after `packages`.";
      };
      writeFiles = mkOption {
        type = types.listOf (types.attrsOf types.anything);
        default = [ ];
        description = "cloud-init write_files entries.";
      };
      cloudConfig = mkOption {
        type = types.attrsOf types.anything;
        default = { };
        description = "Any other top-level cloud-config keys, merged over the generated ones.";
      };
    };

    # Cloud-init fragments for every cloud-image guest - Ubuntu, Arch and
    # Alpine alike (lib/cloud.nix). What a plugin needs on all three goes
    # here; what's distro-specific (apt packages, a desktop's config) in
    # that distro's own half.
    cloud = {
      nixPackages = mkOption {
        type = types.listOf types.package;
        default = [ ];
        description = "Like ubuntu.nixPackages, on every cloud-image guest.";
      };
      writeFiles = mkOption {
        type = types.listOf (types.attrsOf types.anything);
        default = [ ];
        description = "cloud-init write_files entries, on every cloud-image guest.";
      };
      runcmd = mkOption {
        type = types.listOf (types.either types.str (types.listOf types.str));
        default = [ ];
        description = "cloud-init runcmd entries, on every cloud-image guest - after each distro's own.";
      };
    };

    arch = distroHalf "pacman packages, from the Arch Linux Archive for the image's day (lib/cloud.nix)." "Arch";

    # Debian's own half: its apt packages are locked like Ubuntu's
    # (`vm lock`), from Debian's archive and snapshot.debian.org.
    debian = distroHalf "apt packages, locked in <name>.lock.json like Ubuntu's (lib/cloud.nix)." "Debian";

    # Fedora, Rocky and AlmaLinux share package names for what plugins need
    # - one half for the three, from each one's pinned release (lib/cloud.nix).
    dnf = distroHalf "dnf packages, on Fedora, Rocky and AlmaLinux - each from its pinned release (lib/cloud.nix)." "Fedora, Rocky and AlmaLinux";

    opensuse = distroHalf "zypper packages, from openSUSE Leap's release repo (lib/cloud.nix)." "openSUSE";

    alpine = {
      packages = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = "apk packages, from the image's stable branch (lib/cloud.nix).";
      };
      writeFiles = mkOption {
        type = types.listOf (types.attrsOf types.anything);
        default = [ ];
        description = "cloud-init write_files entries, on Alpine only.";
      };
      runcmd = mkOption {
        type = types.listOf (types.either types.str (types.listOf types.str));
        default = [ ];
        description = "cloud-init runcmd entries, on Alpine only - OpenRC, not systemd.";
      };
    };

    nixos.modules = mkOption {
      type = types.listOf types.deferredModule;
      default = [ ];
      description = "NixOS modules added to the guest's system configuration.";
    };

    # Windows' half (lib/windows.nix): no cloud-init, so what a plugin adds
    # is files on the setup disc and PowerShell run once at first logon.
    windows = {
      iso = mkOption {
        type = types.str;
        # Windows 11 Enterprise LTSC 2024 Evaluation (build 26100, 24H2's),
        # English (US): a fixed file on Microsoft's download server - the one
        # its evaluation page links to. No product key; it runs 90 days.
        default = "https://software-static.download.prss.microsoft.com/dbazure/888969d5-f34g-4e03-ac9d-1f9786c66749/26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_LTSC_EVAL_x64FRE_en-us.iso";
        description = ''
          Where the ISO comes from - a fixed URL. Its sha256 is the machine's
          lockfile's: `vm lock` (the first `up` runs it) downloads it once and
          records it, the way it records Ubuntu's .debs.
        '';
      };
      image = mkOption {
        type = types.either types.ints.positive types.str;
        default = 1;
        description = "The image installed from the ISO: its index, or its name (`/IMAGE/NAME`).";
      };
      productKey = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "The key Setup installs with - null for an ISO that asks none, as the evaluation.";
      };
      files = mkOption {
        type = types.attrsOf types.path;
        default = { };
        description = ''
          Files on the setup disc, by name - installers a plugin fetched,
          pinned. `firstLogon` finds them as "$vms\<name>".
        '';
      };
      firstLogon = mkOption {
        type = types.listOf types.lines;
        default = [ ];
        description = ''
          PowerShell, run once at the first logon as the (administrator)
          user, before sshd starts - so `vm ssh` answering means it's done.
          `$vms` is the setup disc's root.
        '';
      };
    };
  };
}
