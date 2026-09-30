# greetd, logging the user straight into a session command at boot - the
# display manager for the desktops that bring none (sway.nix, hyprland.nix),
# which set `greetd.session`. agreety, its plain text greeter, is what's left
# after a log out.
{ config, lib, ... }:

let
  inherit (config.greetd) session;
  inherit (config) user;
  settings = greeter: ''
    [terminal]
    vt = 1

    [default_session]
    command = "agreety --cmd '${session}'"
    user = "${greeter}"

    # Logged straight in, once, at boot.
    [initial_session]
    command = "${session}"
    user = "${user}"
  '';
  # greetd's own user differs by distro.
  configFile = greeter: {
    path = "/etc/greetd/config.toml";
    content = settings greeter;
  };
in
{
  imports = [ ./desktop.nix ];

  options.greetd.session = lib.mkOption {
    type = lib.types.str;
    description = "The command greetd logs the user into: a compositor's, as a shell command.";
  };

  config = {
    desktop.displayManager = "greetd";

    # Debian's greetd doesn't claim display-manager.service; enabled by name.
    ubuntu = {
      packages = [ "greetd" ];
      writeFiles = [ (configFile "_greetd") ];
      runcmd = [ [ "systemctl" "enable" "--now" "greetd" ] ];
    };
    debian = {
      packages = [ "greetd" ];
      writeFiles = [ (configFile "_greetd") ];
      runcmd = [ [ "systemctl" "enable" "--now" "greetd" ] ];
    };
    alpine = {
      packages = [ "greetd" "greetd-openrc" "greetd-agreety" ];
      writeFiles = [ (configFile "greetd") ];
    };

    nixos.modules = [
      ({ config, ... }: {
        services.greetd = {
          enable = true;
          settings = {
            default_session.command = "${config.services.greetd.package}/bin/agreety --cmd '${session}'";
            initial_session = {
              command = session;
              inherit user;
            };
          };
        };
      })
    ];
  };
}
