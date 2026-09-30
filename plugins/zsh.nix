# zsh as the user's login shell, from this repo's nixpkgs on both OSes.
#
# On Ubuntu it's the Nix zsh (see ubuntu.nixPackages), which reads /etc/z*
# rather than Debian's /etc/zsh/, so it gets no system config at all: the
# user's own files below give it Ubuntu's login PATH and a usable shell,
# and stop zsh's new-user wizard, which only runs while they're missing.
# Other plugins add to it with files in /etc/zshrc.d/*.zsh - system-wide,
# since cloud-init would make any missing folder under ~ root's.
{ config, pkgs, ... }:

let
  home = "/home/${config.user}";
  userFile = name: content: {
    path = "${home}/${name}";
    inherit content;
    owner = "${config.user}:${config.user}";
    # Written once the user exists (see lib/ubuntu.nix's userKey).
    defer = true;
  };
  zsh = "/usr/local/bin/zsh";

  # `z` wherever zoxide turns up: installed (the zoxide plugin), or brought
  # by a repo's .envrc through direnv - which carries PATH back to the shell
  # but never functions, and `z` is one `zoxide init` defines. Checked before
  # every prompt, so it's there as soon as direnv has loaded; after direnv's
  # own hook, which runs first (its file sorts before this one).
  zoxideHook = ''
    _vms_zoxide_init() {
      if (( $+commands[zoxide] )) && (( ! $+functions[__zoxide_z] )); then
        eval "$(zoxide init zsh)"
      fi
    }
    precmd_functions+=(_vms_zoxide_init)
    _vms_zoxide_init
  '';
in
{
  ubuntu = {
    nixPackages = [ pkgs.zsh ];
    writeFiles = [
      # What bash's login gets from /etc/profile and ~/.profile (PATH,
      # /etc/profile.d, ~/.local/bin), in sh emulation since they're sh.
      (userFile ".zprofile" ''
        emulate sh -c '. /etc/profile; [ -f "$HOME/.profile" ] && . "$HOME/.profile"'
      '')
      (userFile ".zshrc" ''
        HISTFILE=~/.zsh_history
        HISTSIZE=10000
        SAVEHIST=10000
        setopt share_history hist_ignore_dups
        bindkey -e
        autoload -Uz compinit && compinit
        PROMPT='%F{green}%n@%m%f:%F{blue}%~%f%# '
        # Other plugins' shell setup (the direnv plugin's hook, say).
        for f in /etc/zshrc.d/*.zsh(N); do source "$f"; done
      '')
      {
        path = "/etc/zshrc.d/zoxide.zsh";
        content = zoxideHook;
      }
    ];
    runcmd = [
      # Only once zsh is really there: a login shell that doesn't exist locks
      # the user out of ssh and the desktop alike.
      [ "sh" "-c" "test -x ${zsh} && { grep -qx ${zsh} /etc/shells || echo ${zsh} >> /etc/shells; } && usermod -s ${zsh} ${config.user}" ]
    ];
  };

  nixos.modules = [
    ({ lib, pkgs, ... }: {
      programs.zsh.enable = true;
      # After direnv's hook (programs.direnv adds its own earlier).
      programs.zsh.interactiveShellInit = lib.mkAfter zoxideHook;
      users.users.${config.user}.shell = pkgs.zsh;
      # NixOS's /etc/zshrc already sets up history, completion and a
      # prompt; an empty ~/.zshrc only keeps the new-user wizard away.
      systemd.tmpfiles.rules = [ "f ${home}/.zshrc 0644 ${config.user} users -" ];
    })
  ];
}
