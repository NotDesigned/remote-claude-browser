#requires -Version 5.1
#requires -RunAsAdministrator
#requires -Modules Hyper-V

<#
.SYNOPSIS
Creates a stopped Windows 11 browser VM on an existing Hyper-V switch.
.EXAMPLE
.\New-BrowserVM.ps1 -IsoPath 'D:\Images\Windows11.iso' -SwitchName 'BrowserSwitch' -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$IsoPath,

    [Parameter(Mandatory = $true)]
    [string]$SwitchName,

    [string]$VMName = 'RemoteBrowser-Windows',
    [string]$VMRoot = (Join-Path $env:ProgramData 'RemoteBrowser\VMs'),
    [UInt64]$MemoryStartupBytes = 4GB,
    [int]$ProcessorCount = 4,
    [UInt64]$DiskSizeBytes = 64GB
)

$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $IsoPath -PathType Leaf)) {
    throw 'IsoPath must point to an existing Windows installation ISO.'
}
if ($MemoryStartupBytes -lt 4GB -or $ProcessorCount -lt 2 -or $DiskSizeBytes -lt 64GB) {
    throw 'Windows 11 requires at least 4 GiB RAM, 2 processors and a 64 GiB disk.'
}
$iso = (Get-Item -LiteralPath $IsoPath).FullName
$switch = Get-VMSwitch -Name $SwitchName
if (Get-VM -Name $VMName -ErrorAction SilentlyContinue) {
    throw "A VM named '$VMName' already exists. Choose another name."
}
$VMRoot = [System.IO.Path]::GetFullPath($VMRoot)
$diskDirectory = Join-Path (Join-Path $VMRoot $VMName) 'Disks'
$disk = Join-Path $diskDirectory 'Windows.vhdx'
if (Test-Path -LiteralPath $disk) {
    throw "The disk '$disk' already exists. It will not be replaced."
}

[pscustomobject]@{
    Name = $VMName
    Generation = 2
    ConfigurationRoot = $VMRoot
    InstallationISO = $iso
    Switch = $switch.Name
    FixedMemoryGiB = $MemoryStartupBytes / 1GB
    Processors = $ProcessorCount
    DynamicVHDX = $disk
    DiskCapacityGiB = $DiskSizeBytes / 1GB
    SecureBoot = 'MicrosoftWindows'
    TPM = 'Local key protector'
    AutomaticCheckpoints = $false
    AutomaticStart = 'Nothing'
    StopAction = 'ShutDown'
    StartAfterCreation = $false
} | Format-List | Out-Host

if ($PSCmdlet.ShouldProcess($VMName, 'Create Windows browser VM and disk')) {
    New-Item -ItemType Directory -Path $diskDirectory -Force | Out-Null
    New-VHD -Path $disk -SizeBytes $DiskSizeBytes -Dynamic | Out-Null
    $vm = New-VM -Name $VMName -Generation 2 -Path $VMRoot `
        -MemoryStartupBytes $MemoryStartupBytes -VHDPath $disk -SwitchName $switch.Name
    Set-VMProcessor -VM $vm -Count $ProcessorCount
    Set-VMMemory -VM $vm -DynamicMemoryEnabled $false
    Set-VM -VM $vm -AutomaticCheckpointsEnabled $false `
        -AutomaticStartAction Nothing -AutomaticStopAction ShutDown
    $dvd = Add-VMDvdDrive -VM $vm -Path $iso -Passthru
    Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows `
        -FirstBootDevice $dvd
    Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
    Enable-VMTPM -VM $vm
    Write-Host "Created '$VMName'. The VM is off; use VMConnect when ready to install Windows."
}
