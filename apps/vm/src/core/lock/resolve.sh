# Runs in the guest, over ssh, as `bash -s -- <packages...>` (see index.ts):
# ask apt what installing the packages takes today. apt's plan
# (--print-uris) names each .deb but carries only its MD5; the sha256 comes
# from the Packages indexes apt just fetched and verified against the signed
# InRelease. URIs are %-escaped (+ is %2b), index Filenames aren't.
# Out: "<pool path> <sha256>" per .deb, "MISSING" for a hash not found.
set -e
sudo cloud-init status --wait >/dev/null
sudo apt-get -qq update >&2
sudo apt-get -qq install --print-uris -y "$@" > /tmp/vms-uris
awk -v q="'" '
  function unescape(s,   out, i, c) {
    out = ""
    for (i = 1; i <= length(s); i++) {
      c = substr(s, i, 1)
      if (c == "%") {
        out = out sprintf("%c", (index("0123456789abcdef", tolower(substr(s, i + 1, 1))) - 1) * 16 \
          + index("0123456789abcdef", tolower(substr(s, i + 2, 1))) - 1)
        i += 2
      } else out = out c
    }
    return out
  }
  $1 ~ /[.]deb.$/ { u = $1; gsub(q, "", u); sub(/^.*[/]pool[/]/, "pool/", u); print unescape(u) }
' /tmp/vms-uris > /tmp/vms-want
for f in $(apt-get indextargets --format '$(FILENAME)' 'Identifier: Packages'); do
  /usr/lib/apt/apt-helper cat-file "$f"
done | awk '/^Filename: /{fn=$2} /^SHA256: /{print fn, $2}' > /tmp/vms-hashes
awk 'NR==FNR{h[$1]=$2; next} {print $1, ($1 in h ? h[$1] : "MISSING")}' /tmp/vms-hashes /tmp/vms-want
