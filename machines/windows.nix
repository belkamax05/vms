# Raw Windows 11 (Enterprise LTSC 2024 Evaluation, 90 days): Microsoft's ISO
# installed unattended, one user logged straight in, OpenSSH - see
# lib/windows.nix. The first `up` downloads the ISO and pins its hash in
# windows.lock.json, next to this file.
{
  os = "windows";
  # Its desktop is part of it - there's no console to attach to instead.
  gui = true;
  cpus = 4;
  memory = 8192;
  diskSize = 65536;
  # The first boot is the whole install.
  bootTimeout = 3600;
}
