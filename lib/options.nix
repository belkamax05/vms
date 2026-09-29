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
in
{
  options = {
    name = mkOption {
      type = types.str;
      description = "Machine name - set from machines/<name>.nix, doubles as the guest hostname.";
    };

    os = mkOption {
      type = types.enum [ "ubuntu" "nixos" ];
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
      packages = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = "apt packages, installed by cloud-init on first boot.";
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

    nixos.modules = mkOption {
      type = types.listOf types.deferredModule;
      default = [ ];
      description = "NixOS modules added to the guest's system configuration.";
    };
  };
}
