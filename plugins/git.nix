# git, for working on repos inside the guest (the machine's own vm-ssh key
# is already the guest user's ~/.ssh/id_ed25519 - `vm key <name>` prints it
# for GitHub). From this repo's nixpkgs on both OSes: Ubuntu's own git (the
# cloud image ships one) trails it by a release or more, and nixpkgs' is the
# same git the host's ~/dotfiles profile has.
{ pkgs, ... }:
{
  ubuntu.nixPackages = [ pkgs.git ];

  nixos.modules = [{
    programs.git.enable = true;
  }];
}
