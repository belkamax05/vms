# Raw Alpine Linux: the stock cloud-init image (OpenRC, musl), one user, SSH,
# a serial console - packages from its stable branch (lib/cloud.nix). Small
# by default; a desktop plugin asks for more.
{ lib, ... }:
{
  os = "alpine";
  memory = lib.mkDefault 2048;
}
