# Windows 11 guest: Microsoft's own ISO, untouched, installed unattended
# from an autounattend.xml generated from the machine's config - the role
# cloud-init's seed plays for the cloud images. Nothing is added to the
# image; what's on top - sshd, the keys, a plugin's installers - is set up
# at the first logon, from a second disc built here.
#
# Pinned like every other input: the ISO by URL + the sha256 `vm lock`
# records in the machine's lockfile, and every installer on the setup disc by
# URL + hash. Nothing comes from Windows Update.
#
# Only devices Windows 11 has drivers for out of the box: a SATA disk, an
# Intel e1000e NIC, a standard VGA display, a USB tablet for the mouse. Setup
# skips the TPM, Secure Boot and CPU checks (LabConfig) - the firmware is
# plain OVMF, without either.
#
# The install takes 15-30 minutes on the first `up`, rebooting itself a few
# times; `bootTimeout` gives `vm ssh` an hour for it. Later boots are a
# normal Windows boot.
{ pkgs, lib, cfg, mkRunner, lockFile, ... }:

let
  fetchImage = import ./fetch-image.nix;
  isoUrl = cfg.windows.iso;

  # The ISO's hash is the lockfile's, as the .debs' are for Ubuntu: `vm lock`
  # (which the first `up` runs by itself) downloads the ISO and records it,
  # and from then on every build fetches exactly that file.
  lock =
    if builtins.pathExists lockFile
    then builtins.fromJSON (builtins.readFile lockFile)
    else null;
  lockProblem =
    if lock == null then "has no ${baseNameOf (toString lockFile)} yet"
    else if (lock.url or null) != isoUrl then "has a lockfile for another ISO"
    else null;
  iso =
    if lockProblem != null then null
    else fetchImage { url = isoUrl; hash = lock.sha256; };

  # Microsoft's OpenSSH server for Windows - its MSI, rather than the
  # optional feature, which comes from Windows Update.
  openssh = pkgs.fetchurl {
    url = "https://github.com/PowerShell/Win32-OpenSSH/releases/download/10.0.0.0p2-Preview/OpenSSH-Win64-v10.0.0.0.msi";
    hash = "sha256-3eycU4ZCgHWc+fdHkc79OHEA45RqqEmhwTik7RuWt9k=";
  };

  # NetBIOS' limit: Setup refuses a longer computer name.
  computerName = builtins.substring 0 15 cfg.name;

  # Every component the passes below name carries this.
  component = name: body: ''
    <component name="${name}" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
    ${body}
    </component>
  '';

  commands = tag: list: lib.concatImapStrings (order: command: ''
    <${tag} wcm:action="add"><Order>${toString order}</Order><Path>${command}</Path></${tag}>
  '') list;

  locale = ''
    <InputLocale>en-US</InputLocale>
    <SystemLocale>en-US</SystemLocale>
    <UILanguage>en-US</UILanguage>
    <UserLocale>en-US</UserLocale>
  '';

  # No password: the user logs in automatically, and SSH takes keys only.
  noPassword = "<Password><Value></Value><PlainText>true</PlainText></Password>";

  autounattend = pkgs.writeText "autounattend.xml" ''
    <?xml version="1.0" encoding="utf-8"?>
    <unattend xmlns="urn:schemas-microsoft-com:unattend">
      <settings pass="windowsPE">
        ${component "Microsoft-Windows-International-Core-WinPE" ''
          <SetupUILanguage><UILanguage>en-US</UILanguage></SetupUILanguage>
          ${locale}
        ''}
        ${component "Microsoft-Windows-Setup" ''
          <RunSynchronous>
            ${commands "RunSynchronousCommand" (map
              (check: "reg add HKLM\\SYSTEM\\Setup\\LabConfig /v Bypass${check}Check /t REG_DWORD /d 1 /f")
              [ "TPM" "SecureBoot" "CPU" "RAM" "Storage" ])}
          </RunSynchronous>
          <DiskConfiguration>
            <Disk wcm:action="add">
              <DiskID>0</DiskID>
              <WillWipeDisk>true</WillWipeDisk>
              <CreatePartitions>
                <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>300</Size></CreatePartition>
                <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
                <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
              </CreatePartitions>
              <ModifyPartitions>
                <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition>
                <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID></ModifyPartition>
                <ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>
              </ModifyPartitions>
            </Disk>
          </DiskConfiguration>
          <ImageInstall>
            <OSImage>
              <InstallFrom><MetaData wcm:action="add">${
                if builtins.isInt cfg.windows.image
                then "<Key>/IMAGE/INDEX</Key><Value>${toString cfg.windows.image}</Value>"
                else "<Key>/IMAGE/NAME</Key><Value>${cfg.windows.image}</Value>"
              }</MetaData></InstallFrom>
              <InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>
            </OSImage>
          </ImageInstall>
          <UserData>
            ${lib.optionalString (cfg.windows.productKey != null)
              "<ProductKey><Key>${cfg.windows.productKey}</Key><WillShowUI>OnError</WillShowUI></ProductKey>"}
            <AcceptEula>true</AcceptEula>
          </UserData>
        ''}
      </settings>
      <settings pass="specialize">
        ${component "Microsoft-Windows-Shell-Setup" ''
          <ComputerName>${computerName}</ComputerName>
          <TimeZone>UTC</TimeZone>
        ''}
        ${component "Microsoft-Windows-Deployment" ''
          <RunSynchronous>
            ${commands "RunSynchronousCommand" [
              # No network needed in OOBE, and no Microsoft account.
              "reg add HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\OOBE /v BypassNRO /t REG_DWORD /d 1 /f"
            ]}
          </RunSynchronous>
        ''}
      </settings>
      <settings pass="oobeSystem">
        ${component "Microsoft-Windows-International-Core" locale}
        ${component "Microsoft-Windows-Shell-Setup" ''
          <OOBE>
            <HideEULAPage>true</HideEULAPage>
            <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
            <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
            <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
            <ProtectYourPC>3</ProtectYourPC>
          </OOBE>
          <UserAccounts>
            <LocalAccounts>
              <LocalAccount wcm:action="add">
                <Name>${cfg.user}</Name>
                <Group>Administrators</Group>
                ${noPassword}
              </LocalAccount>
            </LocalAccounts>
          </UserAccounts>
          <AutoLogon>
            <Enabled>true</Enabled>
            <Username>${cfg.user}</Username>
            ${noPassword}
            <LogonCount>9999999</LogonCount>
          </AutoLogon>
          <FirstLogonCommands>
            <SynchronousCommand wcm:action="add">
              <Order>1</Order>
              <CommandLine>cmd /c for %d in (D E F G H I J K) do if exist %d:\vms-setup.ps1 powershell -NoProfile -ExecutionPolicy Bypass -File %d:\vms-setup.ps1</CommandLine>
            </SynchronousCommand>
          </FirstLogonCommands>
        ''}
      </settings>
    </unattend>
  '';

  # The keys, from the runner's own small disc (VMSKEYS) - on every boot, as
  # SYSTEM, so a rotated vm-ssh or a new host key arrives with the next boot.
  # The ACLs are what Windows' OpenSSH insists on: an administrator's
  # authorized keys readable by Administrators and SYSTEM only, a private key
  # by its owner only. SIDs, not names, which Windows translates.
  keysScript = pkgs.writeText "vms-keys.ps1" ''
    $keys = Get-PSDrive -PSProvider FileSystem |
      Where-Object { Test-Path (Join-Path $_.Root 'authorized_keys') } |
      Select-Object -First 1 -ExpandProperty Root
    if (-not $keys) { exit 0 }
    $admin = "$env:ProgramData\ssh\administrators_authorized_keys"
    New-Item -ItemType Directory -Force "$env:ProgramData\ssh" | Out-Null
    Copy-Item (Join-Path $keys 'authorized_keys') $admin -Force
    icacls $admin /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null
    $ssh = 'C:\Users\${cfg.user}\.ssh'
    New-Item -ItemType Directory -Force $ssh | Out-Null
    Copy-Item (Join-Path $keys 'vm-ssh') "$ssh\id_ed25519" -Force
    Copy-Item (Join-Path $keys 'vm-ssh.pub') "$ssh\id_ed25519.pub" -Force
    icacls "$ssh\id_ed25519" /inheritance:r /grant '${cfg.user}:F' /grant '*S-1-5-18:F' | Out-Null
  '';

  # The first logon, as the user, elevated: sshd, the keys, the plugins'
  # steps - and sshd started last, so SSH answering means all of it is done.
  setupScript = pkgs.writeText "vms-setup.ps1" ''
    $vms = (Split-Path -Parent $MyInvocation.MyCommand.Path).TrimEnd('\')
    New-Item -ItemType Directory -Force C:\ProgramData\vms | Out-Null
    Start-Transcript -Path C:\ProgramData\vms\setup.log -Append

    Start-Process msiexec.exe -Wait -ArgumentList '/i', "$vms\openssh.msi", '/qn', '/norestart'
    New-Item -Force HKLM:\SOFTWARE\OpenSSH | Out-Null
    New-ItemProperty HKLM:\SOFTWARE\OpenSSH -Name DefaultShell -PropertyType String -Force `
      -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" | Out-Null
    # `vm` checks SSH with `ssh <host> true`.
    Set-Content -Path "$env:SystemRoot\System32\true.cmd" -Value '@exit /b 0'
    if (-not (Get-NetFirewallRule -Name vms-sshd -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -Name vms-sshd -DisplayName 'OpenSSH (vms)' -Direction Inbound `
        -Protocol TCP -LocalPort 22 -Action Allow | Out-Null
    }

    Copy-Item "$vms\vms-keys.ps1" C:\ProgramData\vms\keys.ps1 -Force
    & C:\ProgramData\vms\keys.ps1
    Register-ScheduledTask -TaskName vms-keys -User SYSTEM -RunLevel Highest -Force `
      -Trigger (New-ScheduledTaskTrigger -AtStartup) `
      -Action (New-ScheduledTaskAction -Execute powershell.exe `
        -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\vms\keys.ps1') | Out-Null

    # A throwaway machine: no sleep, no screen going dark.
    powercfg /change standby-timeout-ac 0
    powercfg /change monitor-timeout-ac 0

    ${lib.concatMapStrings (step: ''
      try {
      ${step}
      } catch { Write-Warning "vms: a first-logon step failed: $_" }
    '') cfg.windows.firstLogon}

    Set-Service sshd -StartupType Automatic
    Start-Service sshd
    New-Item -ItemType File -Force C:\ProgramData\vms\provisioned | Out-Null
    Stop-Transcript
  '';

  # The setup disc: autounattend.xml at its root, where Setup looks for one,
  # the scripts, and every file a plugin put on it.
  setupDisc = pkgs.runCommand "${cfg.name}-setup.iso" { nativeBuildInputs = [ pkgs.xorriso ]; } ''
    mkdir root
    cp ${autounattend} root/autounattend.xml
    cp ${setupScript} root/vms-setup.ps1
    cp ${keysScript} root/vms-keys.ps1
    cp ${openssh} root/openssh.msi
    ${lib.concatStrings (lib.mapAttrsToList (name: file: ''
      cp ${file} root/${lib.escapeShellArg name}
    '') cfg.windows.files)}
    xorriso -as genisoimage -quiet -output $out -volid VMS -joliet -rock root
  '';

  # A fresh disk boots the ISO, whose loader waits for a key ("Press any key
  # to boot from CD or DVD") and otherwise gives up - pressed for it through
  # QEMU's monitor, for the first half minute only.
  pressForBoot = ''
    import socket, sys, time
    for _ in range(60):
        try:
            s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); break
        except OSError:
            time.sleep(0.5)
    else:
        sys.exit(0)
    for _ in range(30):
        s.sendall(b"sendkey ret\n"); time.sleep(1)
  '';
in
assert lib.assertMsg (cfg.packages == [ ])
  "${cfg.name}: tools come from nixpkgs, which has no Windows builds - leave them out";
mkRunner {
  # `vm up` locks first when the lockfile is missing or stale (see
  # apps/vm/src/core/lock), so this only shows when the runner is run by hand.
  script = if lockProblem != null then ''
    echo "vm: ${cfg.name} ${lockProblem} - run: vm lock ${cfg.name}" >&2
    exit 1
  '' else ''
    disk="$VM_STATE/disk.qcow2"
    fresh=
    if [ ! -e "$disk" ]; then
      qemu-img create -q -f qcow2 "$disk" ${toString cfg.diskSize}M
      fresh=1
    fi
    # The firmware's own settings (boot entries), per machine.
    vars="$VM_STATE/OVMF_VARS.fd"
    [ -e "$vars" ] || install -m 644 ${pkgs.OVMF.fd}/FV/OVMF_VARS.fd "$vars"

    mkdir -p "$VM_STATE/keys"
    cp "$VM_PUBKEY" "$VM_STATE/keys/authorized_keys"
    cp "$VM_USER_KEY" "$VM_STATE/keys/vm-ssh"
    cp "$VM_USER_KEY.pub" "$VM_STATE/keys/vm-ssh.pub"
    rm -f "$VM_STATE/keys.iso"
    xorriso -as genisoimage -quiet -output "$VM_STATE/keys.iso" -volid VMSKEYS -joliet -rock \
      "$VM_STATE/keys" 2>/dev/null

    monitor="$VM_STATE/monitor.sock"
    rm -f "$monitor"
    if [ -n "$fresh" ]; then python3 -c ${lib.escapeShellArg pressForBoot} "$monitor" & fi

    qemu-system-x86_64 \
      -name ${cfg.name} -enable-kvm -machine q35 \
      -cpu host,hv_relaxed,hv_vapic,hv_spinlocks=0x1fff,hv_time \
      -smp ${toString cfg.cpus} -m ${toString cfg.memory} -rtc base=localtime \
      -drive if=pflash,format=raw,readonly=on,file=${pkgs.OVMF.fd}/FV/OVMF_CODE.fd \
      -drive if=pflash,format=raw,file="$vars" \
      -drive if=none,id=disk0,file="$disk" -device ide-hd,drive=disk0,bus=ide.0,bootindex=1 \
      -drive if=none,id=cd0,media=cdrom,readonly=on,file=${toString iso} -device ide-cd,drive=cd0,bus=ide.1,bootindex=2 \
      -drive if=none,id=cd1,media=cdrom,readonly=on,file=${setupDisc} -device ide-cd,drive=cd1,bus=ide.2 \
      -drive if=none,id=cd2,media=cdrom,readonly=on,file="$VM_STATE/keys.iso" -device ide-cd,drive=cd2,bus=ide.3 \
      -netdev user,id=net0,hostfwd=tcp:127.0.0.1:"$VM_SSH_PORT"-:22 -device e1000e,netdev=net0 \
      -device qemu-xhci -device usb-tablet \
      -vga std -display gtk \
      -monitor unix:"$monitor",server,nowait \
      -pidfile "$VM_STATE/qemu.pid"
  '';
  runtimeInputs = [ pkgs.qemu pkgs.xorriso pkgs.coreutils pkgs.python3 ];
}
