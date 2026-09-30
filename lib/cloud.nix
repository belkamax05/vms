# Cloud-image guests - Ubuntu, Arch, Alpine: the distro's stock cloud image,
# untouched, plus a cloud-init NoCloud seed generated from the machine's
# config. Nothing here installs anything into the image itself - "raw Ubuntu"
# (or Arch, or Alpine) is exactly what the distro ships, and every change on
# top of it is a cloud-init entry a plugin chose to add. What differs between
# them is only the table below: the image, the package manager, the admin
# group, and how the serial console logs in.
#
# Every image is pinned by URL + hash (a dated release, never "latest").
# What the package manager installs on top is pinned as far as each distro
# allows:
#
#   Ubuntu  the Nix way: `vm lock <name>` resolves the machine's packages
#           once, against the live archive, and records every .deb with its
#           sha256 in <name>.lock.json; the build fetches each by that hash
#           into the store and indexes them into a local repo, and the guest
#           installs from that repo alone. The same lockfile gives the same
#           bytes on every device, with no archive involved after the first
#           fetch.
#   Arch    by date: pacman reads the Arch Linux Archive for the image's own
#           day, so every package is the version it was that day.
#   Debian  as Ubuntu: locked .debs, from Debian's archive (and its separate
#           security archive), snapshot.debian.org as the fallback.
#   Arch    by date, as above.
#   Fedora  by release: only the release repo, frozen the day it shipped -
#           never the updates repo, which moves.
#   Rocky,  by point release (10.2): repos pinned to it, whose content only
#   Alma    takes that point release's fixes, and move to the vault - listed
#           too - once the next one ships.
#   openSUSE Leap, by release: its release repo only, as Fedora.
#   Alpine  by branch: its stable branch (v3.24) only takes fixes, but it has
#           no archive to pin a day in - the one guest whose packages can
#           move under it.
#
# The image's store path is only ever a read-only qcow2 backing file - each
# VM writes to its own overlay in its state dir.
{ pkgs, lib, cfg, mkRunner, lockFile, hostRequests, ... }:

let
  isUbuntu = cfg.os == "ubuntu";
  # The apt guests, whose packages `vm lock` locks .deb by .deb.
  isApt = lib.elem cfg.os [ "ubuntu" "debian" ];

  # Where a locked .deb is fetched from: the archives' pools first, and their
  # snapshots at the moment `vm lock` ran as the fallback - a file superseded
  # since may be pruned from a pool, never from a snapshot, and pool files
  # never change once published. Debian keeps security updates in an archive
  # of its own (pool/updates/...); the one that hasn't the path answers 404
  # and the next is tried.
  aptUrls = path: {
    ubuntu = [
      "http://archive.ubuntu.com/ubuntu/${path}"
      "https://snapshot.ubuntu.com/ubuntu/${lock.snapshot}/${path}"
    ];
    debian = [
      "https://deb.debian.org/debian/${path}"
      "https://deb.debian.org/debian-security/${path}"
      "https://snapshot.debian.org/archive/debian/${lock.snapshot}/${path}"
      "https://snapshot.debian.org/archive/debian-security/${lock.snapshot}/${path}"
    ];
  }.${cfg.os};

  # cloud-init is Python, so every cloud image has it - and not always curl.
  pyFetch = "python3 -c 'import shutil, sys, urllib.request; shutil.copyfileobj(urllib.request.urlopen(sys.argv[1]), sys.stdout.buffer)'";

  # Rocky and AlmaLinux: their repos, pinned to a point release - the live
  # path while it's current, the vault's once the next one ships.
  pinnedDnf = { name, key, urls }: {
    path = "/etc/yum.repos.d/vms-pinned.repo";
    content = lib.concatMapStrings (repo: ''
      [vms-${lib.toLower repo}]
      name=${name} ${repo} (pinned by vms)
      baseurl=${lib.concatMapStringsSep " " (url: "${url}/${repo}/x86_64/os/") urls}
      gpgcheck=1
      gpgkey=file:///etc/pki/rpm-gpg/${key}
      enabled=1

    '') [ "BaseOS" "AppStream" ];
  };
  dnfDistro = { image, repos, pin ? [ ] }: {
    inherit image;
    packages = lib.unique cfg.dnf.packages;
    nixPackages = [ ];
    writeFiles = pin;
    runcmd = [ ];
    adminGroup = "wheel";
    shell = "/bin/bash";
    console = systemdConsole;
    installed = "rpm -q ${lib.escapeShellArgs packages} >/dev/null";
    recover = "";
    fetch = pyFetch;
    install = "dnf install -y --disablerepo='*' ${lib.concatMapStringsSep " " (r: "--enablerepo=${r}") repos} ${lib.escapeShellArgs packages}";
  };

  # One pinned image per `ubuntu.release`. A machine's lockfile is resolved
  # against its release's image, so moving a machine to another release
  # means `vm lock` again (its first `up` does it).
  ubuntuImages = {
    "26.04" = {
      url = "https://cloud-images.ubuntu.com/releases/26.04/release-20260918/ubuntu-26.04-server-cloudimg-amd64.img";
      sha256 = "4908fb59ccd4e87ae4e8e973b7ef56f535448eacb24a87fd787270c0048987bc";
    };
    "24.04" = {
      url = "https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-amd64.img";
      sha256 = "6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2";
    };
  };

  # The Arch image's own day, in the Arch Linux Archive's path form.
  archDay = "2026/09/15";

  # A systemd getty that logs `user` straight in (Ubuntu, Arch).
  systemdAutologin = unit: {
    path = "/etc/systemd/system/${unit}.d/autologin.conf";
    content = ''
      [Service]
      ExecStart=
      ExecStart=-/sbin/agetty --autologin ${cfg.user} --noclear --keep-baud %I 115200,38400,9600 $TERM
    '';
  };
  systemdConsole = {
    files = [
      (systemdAutologin "serial-getty@ttyS0.service")
      (systemdAutologin "getty@tty1.service")
    ];
    runcmd = [
      [ "systemctl" "daemon-reload" ]
      [ "systemctl" "restart" "serial-getty@ttyS0.service" "getty@tty1.service" ]
    ];
  };

  distros = {
    ubuntu = {
      image = pkgs.fetchurl ubuntuImages.${cfg.ubuntu.release};
      packages = lib.unique cfg.ubuntu.packages;
      nixPackages = cfg.ubuntu.nixPackages;
      writeFiles = cfg.ubuntu.writeFiles;
      runcmd = cfg.ubuntu.runcmd;
      adminGroup = "sudo";
      shell = "/bin/bash";
      console = systemdConsole;
      # Only once every package is really there - see `installed` below.
      installed = "dpkg-query -W ${lib.escapeShellArgs packages} >/dev/null";
      # A first boot cut short mid-install leaves dpkg to finish.
      recover = "dpkg --configure -a; ";
      fetch = "curl -fsS";
    };

    arch = {
      image = pkgs.fetchurl {
        url = "https://geo.mirror.pkgbuild.com/images/v20260915.594445/Arch-Linux-x86_64-cloudimg-20260915.594445.qcow2";
        sha256 = "d7cc7c86a21b32d6678c001464714f71f4ef7e0d7bbbfca65e99123ac5afc25b";
      };
      # sudo for the user's passwordless sudo, whatever the image has.
      packages = lib.unique ([ "sudo" ] ++ cfg.arch.packages);
      nixPackages = [ ];
      writeFiles = cfg.arch.writeFiles ++ [
        {
          path = "/etc/pacman.d/mirrorlist";
          content = ''
            Server = https://archive.archlinux.org/repos/${archDay}/$repo/os/$arch
          '';
        }
      ];
      runcmd = cfg.arch.runcmd;
      adminGroup = "wheel";
      shell = "/bin/bash";
      console = systemdConsole;
      installed = "pacman -Q ${lib.escapeShellArgs packages} >/dev/null";
      recover = "rm -f /var/lib/pacman/db.lck; ";
      fetch = "curl -fsS";
    };

    debian = {
      image = pkgs.fetchurl {
        url = "https://cloud.debian.org/images/cloud/trixie/20260914-2601/debian-13-genericcloud-amd64-20260914-2601.qcow2";
        sha512 = "95e110dfcdbd0ed8a82a75ed9579802f9950cabf51a810dcc6388e81bc778188713878b9f28d583a0ea602fbf48b35996ae9ad37f584166d8fbd6489df248f53";
      };
      packages = lib.unique cfg.debian.packages;
      nixPackages = [ ];
      writeFiles = cfg.debian.writeFiles;
      runcmd = cfg.debian.runcmd;
      adminGroup = "sudo";
      shell = "/bin/bash";
      console = systemdConsole;
      installed = "dpkg-query -W ${lib.escapeShellArgs packages} >/dev/null";
      recover = "dpkg --configure -a; ";
      fetch = pyFetch;
    };

    fedora = dnfDistro {
      image = pkgs.fetchurl {
        url = "https://download.fedoraproject.org/pub/fedora/linux/releases/44/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-44-1.7.x86_64.qcow2";
        sha256 = "28680fe5b371a5a82ebf43a31926e086a168e59949d03969c5093e7071f90b7f";
      };
      repos = [ "fedora" ];
    };

    rocky = dnfDistro {
      image = pkgs.fetchurl {
        url = "https://dl.rockylinux.org/pub/rocky/10.2/images/x86_64/Rocky-10-GenericCloud-Base-10.2-20260525.0.x86_64.qcow2";
        sha256 = "9fc9e9ff16888bb68ac39b0392e25c9c92684d50c85f1cce6ab549363bbc4b48";
      };
      repos = [ "vms-baseos" "vms-appstream" ];
      pin = [ (pinnedDnf {
        name = "Rocky Linux 10.2";
        key = "RPM-GPG-KEY-Rocky-10";
        urls = [ "https://dl.rockylinux.org/pub/rocky/10.2" "https://dl.rockylinux.org/vault/rocky/10.2" ];
      }) ];
    };

    alma = dnfDistro {
      image = pkgs.fetchurl {
        url = "https://repo.almalinux.org/almalinux/10.2/cloud/x86_64/images/AlmaLinux-10-GenericCloud-10.2-20260817.0.x86_64.qcow2";
        sha256 = "bc59485c4828861a15887e30ff1bb913f0f16202fd7286208518f4814da1e10a";
      };
      repos = [ "vms-baseos" "vms-appstream" ];
      pin = [ (pinnedDnf {
        name = "AlmaLinux 10.2";
        key = "RPM-GPG-KEY-AlmaLinux-10";
        urls = [ "https://repo.almalinux.org/almalinux/10.2" "https://vault.almalinux.org/10.2" ];
      }) ];
    };

    opensuse = {
      image = pkgs.fetchurl {
        url = "https://download.opensuse.org/distribution/leap/16.0/appliances/Leap-16.0-Minimal-VM.x86_64-Cloud-Build18.68.qcow2";
        sha256 = "6cd286b06cb065ed65287d3b86cf2676b5972eabe4792c2c841f2a40a33138d6";
      };
      packages = lib.unique cfg.opensuse.packages;
      nixPackages = [ ];
      writeFiles = [ ];
      runcmd = [ ];
      adminGroup = "wheel";
      shell = "/bin/bash";
      console = systemdConsole;
      installed = "rpm -q ${lib.escapeShellArgs packages} >/dev/null";
      recover = "";
      fetch = pyFetch;
    };

    alpine = {
      image = pkgs.fetchurl {
        url = "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/cloud/generic_alpine-3.24.1-x86_64-bios-cloudinit-r0.qcow2";
        sha512 = "8d756f6fc7653daa4fb4e2e213d8a66007bcb1e5a846e28891af62c47b90685c694486c2746099ad99e9e8f5278db76b69d11dfe1e9361aa4c8406df16929a9c";
      };
      # sudo as on the others; shadow for usermod; GNU tar and findutils,
      # since the Nix closure step below uses what busybox's lack.
      packages = lib.unique ([ "sudo" "shadow" "tar" "findutils" ] ++ cfg.alpine.packages);
      nixPackages = [ ];
      writeFiles = cfg.alpine.writeFiles ++ [
        {
          path = "/usr/local/sbin/vms-autologin";
          permissions = "0755";
          content = ''
            #!/bin/sh
            exec /bin/login -f ${cfg.user}
          '';
        }
      ];
      runcmd = cfg.alpine.runcmd;
      adminGroup = "wheel";
      # No bash until something installs it; zsh's plugin moves the user on.
      shell = "/bin/sh";
      # OpenRC and busybox init: the serial getty is a line in /etc/inittab.
      console = {
        files = [ ];
        runcmd = [
          # cloud-init's lock_passwd leaves the password field "!", which
          # OpenSSH without PAM (Alpine's) reads as a locked account and
          # refuses even key logins for. "*": still no password, not locked.
          [ "sed" "-i" "s/^${cfg.user}:![^:]*:/${cfg.user}:*:/" "/etc/shadow" ]
          [
            "sh"
            "-c"
            (lib.concatStringsSep "; " [
              "line='ttyS0::respawn:/sbin/getty -n -l /usr/local/sbin/vms-autologin -L 115200 ttyS0 vt100'"
              "if grep -q '^ttyS0::' /etc/inittab; then sed -i \"s|^ttyS0::.*|$line|\" /etc/inittab; else echo \"$line\" >> /etc/inittab; fi"
              "kill -HUP 1"
              "pkill -f 'getty.*ttyS0' || true"
            ])
          ]
        ];
      };
      installed = "apk info -e ${lib.escapeShellArgs packages} >/dev/null";
      recover = "";
      # busybox's wget: curl isn't in the image.
      fetch = "wget -qO-";
    };
  };
  distro = distros.${cfg.os};

  packages = distro.packages;

  # `packages` and each distro's own Nix packages (ubuntu.nixPackages): one
  # env of them all, and its whole closure as a tarball the runner serves
  # next to the .debs. The guest unpacks it into its own /nix/store - store
  # paths are absolute, so that's where they have to live - and links the
  # env's binaries into /usr/local/bin through nixProfile, so that swapping
  # the env (a new config on the same disk) is one symlink. Nix-built
  # binaries carry their own loader and libraries, so this works on Alpine's
  # musl as on the glibc distros.
  nixPackageList = lib.unique (cfg.packages ++ distro.nixPackages ++ cfg.cloud.nixPackages);
  nixPackages = nixPackageList != [ ];
  nixEnv = pkgs.buildEnv { name = "${cfg.name}-nix-packages"; paths = nixPackageList; };
  nixClosure = pkgs.runCommand "${cfg.name}-nix-closure.tar" { } ''
    sed 's|^/||' ${pkgs.closureInfo { rootPaths = [ nixEnv ]; }}/store-paths |
      tar -cf $out -C / --sort=name --mtime=@1 --owner=0 --group=0 --numeric-owner -T -
  '';
  nixProfile = "/nix/var/vms/profile";

  # <name>.lock.json, next to the machine's file (see lib/default.nix),
  # written by `vm lock`: the packages it was resolved for, and every .deb
  # that takes on top of the image. Ubuntu only.
  lock = if isApt && builtins.pathExists lockFile then builtins.fromJSON (builtins.readFile lockFile) else null;
  lockProblem =
    if !isApt || packages == [ ] then null
    else if lock == null then "has no machines/${cfg.name}.lock.json"
    else if lib.sort lib.lessThan lock.packages != lib.sort lib.lessThan packages
    then "machines/${cfg.name}.lock.json was resolved for other packages"
    else null;

  # What the runner serves the guest: the .debs (Ubuntu) and the Nix closure.
  debRepo = pkgs.runCommand "${cfg.name}-debs" { nativeBuildInputs = [ pkgs.dpkg ]; } ''
    mkdir -p $out
    ${lib.concatMapStrings (deb: ''
      ln -s ${pkgs.fetchurl ({
        urls = aptUrls deb.path;
      } // lib.getAttrs (lib.intersectLists [ "sha256" "sha512" ] (lib.attrNames deb)) deb)} $out/${deb.file}
    '') (lib.optionals (lockProblem == null && lock != null) lock.debs)}
    ${lib.optionalString nixPackages "ln -s ${nixClosure} $out/nix-closure.tar"}
    cd $out && dpkg-scanpackages --multiversion . /dev/null > Packages
  '';

  # The machine's own keypair (vm-ssh), substituted by the runner like the
  # authorized key - it's host state, never in the store. Deferred to the
  # final stage: the user, and the ~/.ssh cloud-init makes for its
  # authorized_keys, don't exist yet when write_files normally runs.
  userKey = [
    {
      path = "/home/${cfg.user}/.ssh/id_ed25519";
      encoding = "b64";
      content = "@USER_KEY_B64@";
      owner = "${cfg.user}:${cfg.user}";
      permissions = "0600";
      defer = true;
    }
    {
      path = "/home/${cfg.user}/.ssh/id_ed25519.pub";
      content = "@USER_PUBKEY@\n";
      owner = "${cfg.user}:${cfg.user}";
      permissions = "0644";
      defer = true;
    }
  ];

  # apt pointed at the runner's repo only (@DEBS_URL@, the host as QEMU's
  # user network sees it), with lists of its own - the guest's regular
  # sources, the image's stock ones, stay as they are for whatever you
  # install by hand later.
  localApt = lib.concatStringsSep " " [
    "-o Dir::Etc::SourceList=/etc/vms/apt/local.list"
    "-o Dir::Etc::SourceParts=/etc/vms/apt/empty.d"
    "-o Dir::State::Lists=/var/lib/vms/apt-lists"
  ];
  aptInstall = [
      "sh" "-c"
      (lib.concatStringsSep " && " [
        "mkdir -p /etc/vms/apt/empty.d /var/lib/vms/apt-lists/partial"
        "echo 'deb [trusted=yes] @DEBS_URL@ ./' > /etc/vms/apt/local.list"
        "apt-get ${localApt} update"
        "DEBIAN_FRONTEND=noninteractive apt-get ${localApt} -o Dpkg::Options::=--force-confold install -y ${lib.escapeShellArgs packages}"
      ])
    ];
  installPackages = {
    ubuntu = aptInstall;
    debian = aptInstall;
    fedora = [ "sh" "-c" distro.install ];
    rocky = [ "sh" "-c" distro.install ];
    alma = [ "sh" "-c" distro.install ];
    # Leap's release repo only, as its own repo - not the image's update one.
    opensuse = [
      "sh" "-c"
      (lib.concatStringsSep " && " [
        "{ zypper lr vms-oss >/dev/null 2>&1 || zypper --non-interactive ar -f https://download.opensuse.org/distribution/leap/16.0/repo/oss/ vms-oss; }"
        "zypper --non-interactive --gpg-auto-import-keys install --from vms-oss ${lib.escapeShellArgs packages}"
      ])
    ];
    # The keyring first (the image's pacman-init does it on first boot, and
    # this waits for it), then the whole system to the archive's day - a
    # no-op for an image from that same day - with the packages on top.
    arch = [
      "sh" "-c"
      (lib.concatStringsSep " && " [
        "systemctl start pacman-init.service"
        "pacman -Syu --noconfirm --needed ${lib.escapeShellArgs packages}"
      ])
    ];
    alpine = [
      "sh" "-c"
      "apk update && apk add --no-interactive ${lib.escapeShellArgs packages}"
    ];
  }.${cfg.os};

  # Every step is safe to repeat. Links a previous env had that this one
  # doesn't are dropped; the profile moves last, as the step's done-mark.
  installNixPackages = [
    "sh" "-c"
    (lib.concatStringsSep " && " [
      "${distro.fetch} @DEBS_URL@nix-closure.tar | tar -xf - -C /"
      # SELinux (Fedora, Rocky, Alma, openSUSE): a new /nix takes the root
      # directory's root_t, which sshd may not even read - it then calls the
      # zsh login shell there missing, and turns the user away. The labels
      # the same files would have under /usr instead: usr_t, and bin_t for
      # programs.
      "if command -v selinuxenabled >/dev/null && selinuxenabled; then chcon -R -t usr_t /nix && find /nix/store -mindepth 2 -maxdepth 2 -name bin -exec chcon -R -t bin_t {} +; fi"
      "find /usr/local/bin -lname '${nixProfile}/*' -delete"
      "for bin in ${nixEnv}/bin/*; do ln -sf ${nixProfile}/bin/\"\${bin##*/}\" /usr/local/bin/; done"
      "mkdir -p ${dirOf nixProfile}"
      "ln -sfn ${nixEnv} ${nixProfile}"
    ])
  ];

  provisioned = "/var/lib/vms/provisioned";
  # The first-boot steps that install and configure: deferred files, and
  # runcmd (written by `runcmd`, run by `scripts_user`).
  retried = [ "write_files_deferred" "runcmd" "scripts_user" ];

  base = {
    hostname = cfg.name;
    users = [{
      name = cfg.user;
      groups = [ distro.adminGroup ];
      inherit (distro) shell;
      sudo = "ALL=(ALL) NOPASSWD:ALL";
      lock_passwd = true;
      # Substituted by the runner at boot - the key belongs to this host's
      # `vm` install, not to the repo, so it can't be baked in at build time.
      ssh_authorized_keys = [ "@SSH_PUBKEY@" ];
    }];
    ssh_pwauth = false;
  };

  cloudConfig = lib.recursiveUpdate (base // {
    write_files = distro.console.files ++ userKey ++ distro.writeFiles ++ cfg.cloud.writeFiles;
    # cloud-init marks a step done when it *starts* it, so a first boot cut
    # short (the window closed mid-install) would leave the install half-done
    # and the plugins' commands never run, on every later boot. Until the
    # last step below has run, each boot finishes what the package manager
    # was doing and clears those steps' marks first - bootcmd runs before any
    # of them - so the same boot does them again.
    bootcmd = [
      "[ -e ${provisioned} ] || { ${distro.recover}rm -f ${lib.concatMapStringsSep " " (m: "/var/lib/cloud/instance/sem/config_${m}") retried}; }"
    ];
    runcmd = distro.console.runcmd
      ++ lib.optional (packages != [ ]) installPackages
      ++ lib.optional nixPackages installNixPackages
      ++ distro.runcmd ++ cfg.cloud.runcmd ++ [
      # Only once every package is really there: runcmd carries on past a
      # failed step, and a failed install must be retried next boot.
      [ "sh" "-c" "${lib.optionalString (packages != [ ]) "${distro.installed} && "}${lib.optionalString nixPackages "[ \"$(readlink ${nixProfile})\" = ${nixEnv} ] && "}mkdir -p ${dirOf provisioned} && touch ${provisioned}" ]
    ];
  }) (lib.optionalAttrs isUbuntu cfg.ubuntu.cloudConfig);

  # What `vm lock` boots (Ubuntu): the same user, and the files that land
  # before packages (apt preferences like the gui plugin's), but nothing
  # installed - so apt resolves against exactly the image the machine starts
  # from.
  lockConfig = base // {
    write_files = lib.filter (f: !(f.defer or false)) (distro.writeFiles ++ cfg.cloud.writeFiles);
  };

  # JSON is valid YAML, so cloud-config needs no YAML generator.
  userData = pkgs.writeText "${cfg.name}-user-data"
    "#cloud-config\n${builtins.toJSON cloudConfig}\n";
  lockUserData = pkgs.writeText "${cfg.name}-lock-user-data"
    "#cloud-config\n${builtins.toJSON lockConfig}\n";

  # Stable for a given config, so a reboot doesn't re-run first-boot modules,
  # but new whenever the config changes - on an existing disk, cloud-init
  # then treats it as a new instance and applies the new config.
  instanceId = "${cfg.name}-${builtins.substring 0 12 (builtins.hashString "sha256" (toString userData))}";
in
mkRunner {
  # VM_LOCK=1 (`vm lock`) boots the lock configuration instead; the rest of
  # the contract is the same. The repo server lives as long as QEMU does.
  script = ''
    display=(${if cfg.gui
      then "-vga none -device virtio-vga-gl -display 'gtk,gl=on' -serial null"
      else "-nographic"})
    if [ "''${VM_LOCK:-0}" = 1 ]; then
      user_data=${lockUserData}
      display=(-nographic)
    else
      ${if lockProblem != null then ''
        echo "vm: ${cfg.name} ${lockProblem} - run: vm lock ${cfg.name}" >&2
        exit 1
      '' else "user_data=${userData}"}
    fi

    disk="$VM_STATE/disk.qcow2"
    if [ ! -e "$disk" ]; then
      qemu-img create -q -f qcow2 -F qcow2 -b ${distro.image} "$disk" ${toString cfg.diskSize}M
    fi

    # The .debs, served on the host's loopback - which the guest reaches as
    # 10.0.2.2 on QEMU's user network, and nothing else can reach at all.
    python3 - ${debRepo} "$VM_STATE/debs-port" <<'PY' &
    import functools, http.server, sys
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=sys.argv[1])
    handler.func.log_message = lambda *args: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    open(sys.argv[2], "w").write(str(server.server_address[1]))
    server.serve_forever()
    PY
    server=$!
    trap 'kill "$server" 2>/dev/null' EXIT
    rm -f "$VM_STATE/debs-port"
    until [ -s "$VM_STATE/debs-port" ]; do sleep 0.1; done
    debs_url="http://10.0.2.2:$(cat "$VM_STATE/debs-port")/"

    mkdir -p "$VM_STATE/seed"
    pubkey="$(cat "$VM_PUBKEY")"
    userpub="$(cat "$VM_USER_KEY.pub")"
    userkey="$(base64 -w0 "$VM_USER_KEY")"
    # g: the user-data is one line of JSON, and @DEBS_URL@ is in it more than once.
    sed -e "s|@SSH_PUBKEY@|$pubkey|g" -e "s|@USER_PUBKEY@|$userpub|g" -e "s|@USER_KEY_B64@|$userkey|g" \
      -e "s|@DEBS_URL@|$debs_url|g" "$user_data" > "$VM_STATE/seed/user-data"
    printf 'instance-id: %s\nlocal-hostname: %s\n' ${instanceId} ${cfg.name} > "$VM_STATE/seed/meta-data"
    rm -f "$VM_STATE/seed.iso"
    xorriso -as genisoimage -quiet -output "$VM_STATE/seed.iso" -volid cidata -joliet -rock \
      "$VM_STATE/seed/user-data" "$VM_STATE/seed/meta-data" 2>/dev/null

    ${hostRequests.start}
    # shellcheck disable=SC2086 # hostRequests.qemuArgs is several words
    qemu-system-x86_64 ${hostRequests.qemuArgs} \
      -name ${cfg.name} -enable-kvm -machine q35 -cpu host \
      -smp ${toString cfg.cpus} -m ${toString cfg.memory} \
      -drive if=virtio,file="$disk" \
      -drive if=virtio,media=cdrom,readonly=on,file="$VM_STATE/seed.iso" \
      -netdev user,id=net0,hostfwd=tcp:127.0.0.1:"$VM_SSH_PORT"-:22 \
      -device virtio-net-pci,netdev=net0 \
      -device virtio-rng-pci \
      -pidfile "$VM_STATE/qemu.pid" \
      "''${display[@]}"
  '';
  runtimeInputs = [ pkgs.qemu pkgs.xorriso pkgs.gnused pkgs.coreutils pkgs.python3 ];
}
