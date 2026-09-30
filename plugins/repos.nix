# Git repos cloned into the guest user's home, over SSH with the machine's
# own vm-ssh key - which GitHub only takes once it's added there, so this
# can't happen on first boot. Instead, every login runs repos.sh - a desktop
# login in a window of its own, a console or SSH login in its own terminal:
# with every repo cloned it exits and nothing opens; otherwise the terminal shows
# the key to add on GitHub, waits for Space until GitHub accepts it, clones
# what's missing and closes. A clone refused for SAML SSO waits the same way,
# for the key to be authorized for that org. Either way the right GitHub page
# opens in the host's browser (the guest has none), through lib/default.nix's
# hostRequests, which needs no desktop either.
#
#   repos = [ { url = "git@github.com:owner/repo.git"; dir = "src/repo"; } ];
#
# GitHub's host keys are pinned below, so the first connection never asks to
# trust one. Checked against https://api.github.com/meta's fingerprints.
{ config, lib, pkgs, ... }:

let
  inherit (lib) mkOption types;

  script = builtins.replaceStrings [ "@REPOS@" ]
    [ (lib.concatMapStringsSep "\n" (repo: "${repo.url} ${repo.dir}") config.repos) ]
    (builtins.readFile ./repos.sh);

  # A console or SSH login: the script in that terminal. Only an interactive
  # one - not `ssh host command`, not a desktop's own non-interactive
  # /etc/profile - and it returns at once when there's nothing to clone.
  loginHook = exec: ''
    case $- in
      *i*) [ -t 0 ] && [ -x ${exec} ] && ${exec} --in-terminal ;;
    esac
  '';

  autostart = exec: ''
    [Desktop Entry]
    Type=Application
    Name=Clone repos
    Exec=${exec}
    NoDisplay=true
    X-GNOME-Autostart-enabled=true
  '';

  githubKeys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
    "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg="
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk="
  ];
in
{
  imports = [ ./git.nix ];

  options.repos = mkOption {
    type = types.listOf (types.submodule {
      options = {
        url = mkOption {
          type = types.str;
          description = "An SSH clone URL, git@github.com:owner/repo.git.";
        };
        dir = mkOption {
          type = types.str;
          description = "Where it goes, relative to the user's home.";
        };
      };
    });
    default = [ ];
  };

  config = {
    cloud.writeFiles = [
      {
        path = "/usr/local/bin/vms-repos";
        content = script;
        permissions = "0755";
      }
      {
        path = "/etc/xdg/autostart/vms-repos.desktop";
        content = autostart "/usr/local/bin/vms-repos";
      }
      # /etc/profile sources it in every login shell - zsh's too, through the
      # zsh plugin's ~/.zprofile.
      {
        path = "/etc/profile.d/vms-repos.sh";
        content = loginHook "/usr/local/bin/vms-repos";
      }
      {
        path = "/etc/ssh/ssh_known_hosts";
        content = lib.concatMapStrings (key: "github.com ${key}\n") githubKeys;
      }
    ];

    nixos.modules = [{
      environment.etc."xdg/autostart/vms-repos.desktop".text =
        autostart "${pkgs.writeScript "vms-repos" script}";
      environment.loginShellInit = loginHook "${pkgs.writeScript "vms-repos" script}";
      programs.ssh.knownHosts = lib.listToAttrs (lib.imap0
        (i: key: lib.nameValuePair "github-${toString i}" {
          hostNames = [ "github.com" ];
          publicKey = key;
        })
        githubKeys);
    }];
  };
}
