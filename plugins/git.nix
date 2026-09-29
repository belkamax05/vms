# git, for working on repos inside the guest (the machine's own vm-ssh key
# is already the guest user's ~/.ssh/id_ed25519 - `vm key <name>` prints it
# for GitHub). The Ubuntu cloud image may already ship git; listing it still
# pins the version `vm lock` resolved, like any other package.
{ ... }:
{
  ubuntu.packages = [ "git" ];

  nixos.modules = [{
    programs.git.enable = true;
  }];
}
