# Not used by factory dispatch. An ACL is not a read-only boundary and does not
# cover a token that can take ownership. Windows dispatch fails closed.
# Holds WRITE_DAC handles, then denies write, create, delete, rename, and DACL changes.
# Stdin and stdout are JSON lines. icacls output is not written to stdout.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$WarningPreference = "SilentlyContinue"
$InformationPreference = "SilentlyContinue"
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WorktreeAcl {
  [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr template);
  [DllImport("advapi32", SetLastError=true)]
  public static extern uint GetSecurityInfo(IntPtr handle, int type, int securityInfo, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);
  [DllImport("advapi32", SetLastError=true)]
  public static extern bool SetKernelObjectSecurity(IntPtr handle, int info, IntPtr sd);
  [DllImport("kernel32", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32", SetLastError=true)]
  public static extern IntPtr LocalFree(IntPtr h);
}
"@

$script:roots = @{}

function Write-Reply([int]$Id, [bool]$Ok, [string]$ErrorText) {
  $safe = ""
  if ($ErrorText) {
    $safe = $ErrorText.Replace([string][char]92, ([string][char]92 + [string][char]92)).Replace([string][char]34, ([string][char]92 + [string][char]34)) -replace "[`r`n]+", " "
  }
  $flag = "false"
  if ($Ok) { $flag = "true" }
  $json = '{"id":' + $Id + ',"ok":' + $flag + ',"error":"' + $safe + '"}'
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Close-Held($list) {
  foreach ($item in @($list)) {
    if ($item.handle -ne [IntPtr]::Zero) { [WorktreeAcl]::CloseHandle($item.handle) | Out-Null }
    if ($item.sd -ne [IntPtr]::Zero) { [WorktreeAcl]::LocalFree($item.sd) | Out-Null }
  }
}

function Invoke-Icacls([string]$Path, [string[]]$Arguments) {
  $out = [System.IO.Path]::GetTempFileName()
  $err = [System.IO.Path]::GetTempFileName()
  try {
    $proc = Start-Process -FilePath "icacls.exe" -ArgumentList (@($Path) + $Arguments) -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
    if ($proc.ExitCode -ne 0) {
      $detail = ""
      if (Test-Path -LiteralPath $err) { $detail = (Get-Content -LiteralPath $err -Raw -ErrorAction SilentlyContinue) }
      if (-not $detail -and (Test-Path -LiteralPath $out)) { $detail = (Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue) }
      throw "icacls $($Arguments[0]) failed on $Path ($($proc.ExitCode)) $detail"
    }
  } finally {
    Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = 0
  try {
    $msg = $line | ConvertFrom-Json
    $id = [int]$msg.id
    $op = [string]$msg.op
    $root = [string]$msg.root
    if ($op -eq "hold") {
      if ($script:roots.ContainsKey($root)) { Close-Held $script:roots[$root]; $script:roots.Remove($root) }
      $opened = @()
      foreach ($entry in @($msg.entries)) {
        $path = [string]$entry.psobject.Properties["path"].Value
        $dir = [bool]$entry.psobject.Properties["dir"].Value
        $handle = [WorktreeAcl]::CreateFileW($path, [uint32]0x60000, [uint32]7, [IntPtr]::Zero, [uint32]3, [uint32]0x02200000, [IntPtr]::Zero)
        if ($handle -eq [IntPtr]::Zero -or $handle.ToInt64() -eq -1) {
          Close-Held $opened
          throw "could not open $path ($([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
        }
        $owner = [IntPtr]::Zero
        $group = [IntPtr]::Zero
        $dacl = [IntPtr]::Zero
        $sacl = [IntPtr]::Zero
        $sd = [IntPtr]::Zero
        $rc = [WorktreeAcl]::GetSecurityInfo($handle, 1, 4, [ref]$owner, [ref]$group, [ref]$dacl, [ref]$sacl, [ref]$sd)
        if ($rc -ne 0 -or $sd -eq [IntPtr]::Zero) {
          [WorktreeAcl]::CloseHandle($handle) | Out-Null
          Close-Held $opened
          throw "could not read the security descriptor for $path ($rc)"
        }
        $opened += [pscustomobject]@{ path = $path; dir = $dir; handle = $handle; sd = $sd }
      }
      $script:roots[$root] = $opened
      Write-Reply $id $true ""
    } elseif ($op -eq "lock") {
      if (-not $script:roots.ContainsKey($root)) { throw "worktree was not prepared" }
      $sid = [string][System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      if ($sid -notmatch "^S-\d-\d+(-\d+)+$") { throw "could not read the current user SID" }
      foreach ($item in @($script:roots[$root])) {
        $rights = "(WD,AD,WA,WEA,DE,WDAC,WO)"
        if ($item.dir) { $rights = "(OI)(CI)(WD,AD,WA,WEA,DC,DE,WDAC,WO)" }
        Invoke-Icacls $item.path @("/deny", ("*" + $sid + ":" + $rights), "/Q")
        Invoke-Icacls $item.path @("/grant:r", "*S-1-3-4:(RX)", "/Q")
      }
      Write-Reply $id $true ""
    } elseif ($op -eq "restore") {
      if ($script:roots.ContainsKey($root)) {
        $list = @($script:roots[$root])
        foreach ($item in $list) {
          $ok = [WorktreeAcl]::SetKernelObjectSecurity($item.handle, 4, $item.sd)
          if (-not $ok) { throw "could not restore $item.path ($([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
        }
        Close-Held $list
        $script:roots.Remove($root)
      }
      Write-Reply $id $true ""
    } else {
      throw "unknown worktree acl operation"
    }
  } catch {
    Write-Reply $id $false $_.Exception.Message
  }
}
