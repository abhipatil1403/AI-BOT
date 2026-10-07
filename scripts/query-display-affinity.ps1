param([Parameter(Mandatory = $true)][string]$Handles)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CaptureAffinityQuery {
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowDisplayAffinity(IntPtr window, out uint affinity);
}
'@
$results = foreach ($handleText in $Handles.Split(',')) {
    [UInt64]$handleNumber = 0
    if (-not [UInt64]::TryParse($handleText, [ref]$handleNumber)) { throw 'Invalid test window handle' }
    [UInt32]$affinity = 0
    if (-not [CaptureAffinityQuery]::GetWindowDisplayAffinity([IntPtr]::new([Int64]$handleNumber), [ref]$affinity)) { throw 'Could not read test window display affinity' }
    [int]$affinity
}
ConvertTo-Json -InputObject @($results) -Compress
