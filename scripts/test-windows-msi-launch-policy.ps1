#requires -Version 7.6.5
[CmdletBinding()]
param([Parameter(Mandatory)][string]$MsiPath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'MSI launch policy validation requires Windows Installer.' }
$MsiPath = (Resolve-Path -LiteralPath $MsiPath).Path
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase($MsiPath, 0)

function Read-MsiRows {
    param([string]$Query, [int]$Columns)
    $view = $database.OpenView($Query)
    try {
        [void]$view.Execute()
        while ($null -ne ($record = $view.Fetch())) {
            $values = for ($column = 1; $column -le $Columns; $column++) {
                $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, @($column))
            }
            [pscustomobject]@{ Values = @($values) }
        }
    } finally { [void]$view.Close() }
}

$properties = @{}
Read-MsiRows 'SELECT `Property`, `Value` FROM `Property`' 2 | ForEach-Object {
    $properties[$_.Values[0]] = $_.Values[1]
}
if ($properties.ContainsKey('WIXUI_EXITDIALOGOPTIONALCHECKBOX') -or $properties.ContainsKey('KAIGEN_RELAUNCH')) {
    throw 'MSI must leave the launch checkbox unchecked and omit the legacy autolaunch default.'
}
if ($properties['WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT'] -cne 'Launch Kaigen' -or
    $properties['MSIDISABLERMRESTART'] -cne '1') {
    throw 'MSI must offer Launch Kaigen and suppress automatic Restart Manager relaunch.'
}
if ($properties['REINSTALLMODE'] -cne 'amus') { throw 'MSI must replace the exact packaged program files.' }
$executeRows = @(Read-MsiRows 'SELECT `Action`, `Sequence`, `Condition` FROM `InstallExecuteSequence`' 3)
$sequence = @{}; $conditions = @{}
foreach ($row in $executeRows) { $sequence[$row.Values[0]]=[int]$row.Values[1]; $conditions[$row.Values[0]]=$row.Values[2] }
foreach ($name in @('CostFinalize','RejectKaigenUpgradeRelocation','ShutdownKaigenBeforeUpdate','InstallInitialize','InstallExecute','RemoveExistingProducts','InstallFinalize','DefaultKaigenInstallFolder')) {
    if (-not $sequence.ContainsKey($name)) { throw "MSI transaction action missing: $name" }
}
if (-not ($sequence['DefaultKaigenInstallFolder'] -lt $sequence['CostFinalize'] -and
    $sequence['CostFinalize'] -lt $sequence['RejectKaigenUpgradeRelocation'] -and
    $sequence['RejectKaigenUpgradeRelocation'] -lt $sequence['ShutdownKaigenBeforeUpdate'] -and
    $sequence['ShutdownKaigenBeforeUpdate'] -lt $sequence['InstallInitialize'] -and
    $sequence['InstallExecute'] -lt $sequence['RemoveExistingProducts'] -and
    $sequence['RemoveExistingProducts'] -lt $sequence['InstallFinalize'])) {
    throw 'MSI must reject relocation before mutation and remove the previous product inside the late transaction.'
}
$guard = @(Read-MsiRows 'SELECT `Type`, `Source`, `Target` FROM `CustomAction` WHERE `Action` = ''RejectKaigenUpgradeRelocation''' 3)
if ($guard.Count -ne 1 -or [int]$guard[0].Values[0] -ne 19 -or $guard[0].Values[1]) { throw 'Relocation rejection must be an MSI-native error action.' }
$search = @(Read-MsiRows 'SELECT `Signature_` FROM `AppSearch` WHERE `Property` = ''KAIGEN_EXISTING_INSTALLFOLDER''' 1)
if ($search.Count -ne 1) { throw 'MSI must read the existing folder independently of INSTALLFOLDER.' }
$locator = @(Read-MsiRows 'SELECT `Root`, `Key`, `Name`, `Type` FROM `RegLocator` WHERE `Signature_` = ''InstallFolderSearch''' 4)
if ($locator.Count -ne 1 -or $locator[0].Values[0] -cne '1' -or $locator[0].Values[1] -cne 'Software\Kaigen\Installer' -or
    $locator[0].Values[2] -cne 'InstallFolder' -or [int]$locator[0].Values[3] -ne 18) { throw 'MSI existing-folder search must use the existing HKCU 64-bit record.' }
$tables = @(Read-MsiRows 'SELECT `Name` FROM `_Tables`' 1 | ForEach-Object { $_.Values[0] })
foreach ($table in @('InstallExecuteSequence', 'InstallUISequence', 'AdminExecuteSequence', 'AdminUISequence', 'AdvtExecuteSequence')) {
    if ($table -in $tables) {
        $scheduled = @(Read-MsiRows ('SELECT `Action` FROM `' + $table + '` WHERE `Action` = ''LaunchKaigenAfterInstall''') 1)
        if ($scheduled.Count -ne 0) { throw "MSI launch action must not be scheduled in $table." }
    }
}
$events = @(Read-MsiRows 'SELECT `Dialog_`, `Control_`, `Condition`, `Ordering` FROM `ControlEvent` WHERE `Event` = ''DoAction'' AND `Argument` = ''LaunchKaigenAfterInstall''' 4)
if ($events.Count -ne 1 -or $events[0].Values[0] -cne 'ExitDialog' -or
    $events[0].Values[1] -cne 'Finish' -or $events[0].Values[3] -cne '1') {
    throw 'MSI must launch only through the successful Finish button, before the dialog closes.'
}
$finishEvents = @(Read-MsiRows 'SELECT `Ordering` FROM `ControlEvent` WHERE `Dialog_` = ''ExitDialog'' AND `Control_` = ''Finish'' AND `Event` = ''EndDialog''' 1)
if ($finishEvents.Count -ne 1 -or [int]$finishEvents[0].Values[0] -le 1) {
    throw 'MSI Finish must launch the selected application before ending the dialog.'
}
$checkbox = @(Read-MsiRows 'SELECT `Property` FROM `Control` WHERE `Dialog_` = ''ExitDialog'' AND `Control` = ''OptionalCheckBox'' AND `Type` = ''CheckBox''' 1)
if ($checkbox.Count -ne 1 -or $checkbox[0].Values[0] -cne 'WIXUI_EXITDIALOGOPTIONALCHECKBOX') {
    throw 'MSI Finish checkbox must control the launch choice.'
}

if (-not ('KaigenMsiLaunchPolicyNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class KaigenMsiLaunchPolicyNative {
    [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern uint MsiOpenPackageExW(string path, uint options, out uint handle);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern uint MsiSetPropertyW(uint handle, string name, string value);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern int MsiEvaluateConditionW(uint handle, string condition);
    [DllImport("msi.dll", ExactSpelling = true)]
    public static extern uint MsiCloseHandle(uint handle);
}
'@
}
[uint32]$session = 0
# Ignore installed machine state: evaluate the exact MSI condition without
# executing any installation or custom action or touching an existing install.
$openResult = [KaigenMsiLaunchPolicyNative]::MsiOpenPackageExW($MsiPath, 1, [ref]$session)
if ($openResult -ne 0) { throw "Cannot open MSI condition session: $openResult" }
try {
    $cases = @(
        @{ Name = 'install-default'; Choice = ''; Installed = ''; Remove = ''; Upgrade = ''; Legacy = ''; Expected = 0 },
        @{ Name = 'install-selected'; Choice = '1'; Installed = ''; Remove = ''; Upgrade = ''; Legacy = ''; Expected = 1 },
        @{ Name = 'install-deselected'; Choice = '0'; Installed = ''; Remove = ''; Upgrade = ''; Legacy = ''; Expected = 0 },
        @{ Name = 'upgrade-default'; Choice = ''; Installed = ''; Remove = ''; Upgrade = '{00000000-0000-0000-0000-000000000001}'; Legacy = ''; Expected = 0 },
        @{ Name = 'upgrade-selected'; Choice = '1'; Installed = ''; Remove = ''; Upgrade = '{00000000-0000-0000-0000-000000000001}'; Legacy = ''; Expected = 1 },
        @{ Name = 'repair'; Choice = '1'; Installed = '1'; Remove = ''; Upgrade = ''; Legacy = ''; Expected = 0 },
        @{ Name = 'uninstall'; Choice = '1'; Installed = '1'; Remove = 'ALL'; Upgrade = ''; Legacy = ''; Expected = 0 },
        @{ Name = 'remove-without-installed'; Choice = '1'; Installed = ''; Remove = 'all'; Upgrade = ''; Legacy = ''; Expected = 0 },
        @{ Name = 'legacy-property'; Choice = ''; Installed = ''; Remove = ''; Upgrade = ''; Legacy = '1'; Expected = 0 }
    )
    foreach ($case in $cases) {
        $inputs = @{
            WIXUI_EXITDIALOGOPTIONALCHECKBOX = $case.Choice
            Installed = $case.Installed
            REMOVE = $case.Remove
            WIX_UPGRADE_DETECTED = $case.Upgrade
            KAIGEN_RELAUNCH = $case.Legacy
        }
        foreach ($entry in $inputs.GetEnumerator()) {
            if ([KaigenMsiLaunchPolicyNative]::MsiSetPropertyW($session, $entry.Key, $entry.Value) -ne 0) {
                throw "Cannot set MSI condition input $($entry.Key)."
            }
        }
        $actual = [KaigenMsiLaunchPolicyNative]::MsiEvaluateConditionW($session, $events[0].Values[2])
        if ($actual -ne $case.Expected) { throw "MSI launch condition failed: $($case.Name), result=$actual" }
    }
    $relocationCases = @(
        @{Name='fresh-custom-folder'; Related=''; Existing=''; Target='C:\Fresh\'; Expected=0},
        @{Name='same-upgrade-folder'; Related='{00000000-0000-0000-0000-000000000001}'; Existing='C:\Kaigen\'; Target='C:\Kaigen\'; Expected=0},
        @{Name='same-upgrade-folder-case'; Related='{00000000-0000-0000-0000-000000000001}'; Existing='C:\Kaigen\'; Target='c:\KAIGEN\'; Expected=0},
        @{Name='changed-upgrade-folder'; Related='{00000000-0000-0000-0000-000000000001}'; Existing='C:\Kaigen\'; Target='C:\Other\'; Expected=1},
        @{Name='missing-existing-folder'; Related='{00000000-0000-0000-0000-000000000001}'; Existing=''; Target='C:\Kaigen\'; Expected=1},
        @{Name='missing-target-folder'; Related='{00000000-0000-0000-0000-000000000001}'; Existing='C:\Kaigen\'; Target=''; Expected=1},
        @{Name='multiple-related-products'; Related='{00000000-0000-0000-0000-000000000001};{00000000-0000-0000-0000-000000000002}'; Existing='C:\Kaigen\'; Target='C:\Kaigen\'; Expected=1}
    )
    foreach ($case in $relocationCases) {
        foreach ($entry in @{WIX_UPGRADE_DETECTED=$case.Related;KAIGEN_EXISTING_INSTALLFOLDER=$case.Existing;INSTALLFOLDER=$case.Target}.GetEnumerator()) {
            if ([KaigenMsiLaunchPolicyNative]::MsiSetPropertyW($session, $entry.Key, $entry.Value) -ne 0) { throw 'Cannot set relocation condition input.' }
        }
        $actual = [KaigenMsiLaunchPolicyNative]::MsiEvaluateConditionW($session, $conditions['RejectKaigenUpgradeRelocation'])
        if ($actual -ne $case.Expected) { throw "MSI relocation condition failed: $($case.Name), result=$actual" }
    }
} finally {
    [void][KaigenMsiLaunchPolicyNative]::MsiCloseHandle($session)
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)
}
Write-Host "MSI_LAUNCH_POLICY_PASS cases=$($cases.Count) relocationCases=$($relocationCases.Count) checkboxDefault=unchecked launch=finish-dialog-only restartManagerRelaunch=disabled lateRemoval=transactional replacement=amus"
