# git, for working on repos inside the guest (the machine's own vm-ssh key
# is already the guest user's ~/.ssh/id_ed25519 - `vm key <name>` prints it
# for GitHub). From this repo's nixpkgs on the Linux guests: Ubuntu's own git
# (the cloud image ships one) trails it by a release or more, and nixpkgs' is
# the same git the host's ~/dotfiles profile has. On Windows, Git for
# Windows' own installer, pinned, run silently at the first logon - it puts
# git on PATH, and its ssh reads the same ~/.ssh/id_ed25519.
{ pkgs, ... }:
{
  cloud.nixPackages = [ pkgs.git ];

  nixos.modules = [{
    programs.git.enable = true;
  }];

  windows = {
    files."git-setup.exe" = pkgs.fetchurl {
      url = "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/Git-2.56.0.2-64-bit.exe";
      hash = "sha256-UhiPkXs3jwDHDsE2vPCQAF8w1E+8TroLznWcxlktYPY=";
    };
    firstLogon = [ ''
      Start-Process -Wait "$vms\git-setup.exe" -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES'
    '' ];
  };
}
