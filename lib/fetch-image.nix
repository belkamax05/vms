# An OS image (a cloud image, an ISO) by URL + hash, downloaded by Nix itself
# (`builtin:fetchurl`, what nixpkgs' own bootstrap tarballs use) rather than
# by curl inside a build like pkgs.fetchurl - so Nix reports the transfer, and
# `vm` can show its progress. Same name and hash as pkgs.fetchurl's, so the
# same store path: nothing already downloaded is fetched again.
{ url, sha256 ? null, sha512 ? null, hash ? null }:

derivation {
  name = baseNameOf url;
  builder = "builtin:fetchurl";
  system = "builtin";
  inherit url;
  outputHashMode = "flat";
  # An SRI hash says its own algorithm; a bare one is the argument's.
  outputHash = if hash != null then hash else if sha512 != null then sha512 else sha256;
  outputHashAlgo = if hash != null then null else if sha512 != null then "sha512" else "sha256";
  unpack = false;
  executable = false;
  preferLocalBuild = true;
  impureEnvVars = [ "http_proxy" "https_proxy" "ftp_proxy" "all_proxy" "no_proxy" ];
}
