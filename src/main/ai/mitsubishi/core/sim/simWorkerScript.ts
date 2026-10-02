/**
 * Inline PowerShell 5.1 worker script for the GX Simulator2 MX Component
 * bridge (Phase B behavior verification).
 *
 * Runs under 32-bit PowerShell (SysWOW64) because ActUtlType is a 32-bit COM
 * server — spawned by PsWorker with powershellPath pointed at
 * C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe. Same NDJSON
 * protocol as the UIA worker (see psWorkerScript.ts).
 *
 * The ActUtlType connection is held in script scope across calls; a worker
 * kill (call timeout) drops the COM reference with the process, so the next
 * `open` transparently rebuilds it.
 *
 * Requires MELSOFT MX Component installed and the logical station configured
 * (Communication Setup Utility -> logical station N -> GX Simulator2).
 *
 * NOTE: this constant must stay a template literal WITHOUT `${` sequences or
 * backticks in the PowerShell code.
 */
export const SIM_WORKER_SCRIPT = `# gx-sim-worker - resident ActUtlType worker for the CKPLCStudio sim bridge.
# NDJSON protocol over stdio; exits on stdin EOF or the "exit" op.
$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

$script:act = $null
$script:station = -1

function Close-Act {
    if ($null -ne $script:act) {
        try { [void]$script:act.Close() } catch {}
        try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($script:act) } catch {}
        $script:act = $null
        $script:station = -1
    }
}

function Open-Act([int]$station) {
    if ($null -ne $script:act -and $script:station -eq $station) {
        return @{ station = $station; reopened = $false }
    }
    Close-Act
    $act = New-Object -ComObject ActUtlType.ActUtlType
    $act.ActLogicalStationNumber = $station
    $hr = $act.Open()
    if ($hr -ne 0) {
        throw ('ActUtlType.Open failed: 0x' + $hr.ToString('X8') + ' (station ' + $station + '). ' +
            '0xF0000002 means the logical station is not configured - open the Communication Setup Utility (ActComm, run as administrator) and point logical station ' +
            $station + ' at GX Simulator2. Also verify MX Component is installed and this worker runs 32-bit PowerShell.')
    }
    $script:act = $act
    $script:station = $station
    return @{ station = $station; reopened = $true }
}

function Get-DeviceValue([string]$device) {
    if ($null -eq $script:act) { throw 'not connected - call open first' }
    $value = [int]0
    $hr = $script:act.GetDevice($device, [ref]$value)
    if ($hr -ne 0) {
        throw ('GetDevice(' + $device + ') failed: 0x' + $hr.ToString('X8'))
    }
    return $value
}

function Set-DeviceValue([string]$device, [int]$value) {
    if ($null -eq $script:act) { throw 'not connected - call open first' }
    $hr = $script:act.SetDevice($device, $value)
    if ($hr -ne 0) {
        throw ('SetDevice(' + $device + ', ' + $value + ') failed: 0x' + $hr.ToString('X8'))
    }
    return $true
}

function Invoke-Op([string]$op, $params) {
    switch ($op) {
        'ping' {
            return @{ pid = $PID; bitness = ([IntPtr]::Size * 8); version = 1 }
        }
        'open' {
            $station = 1
            if ($null -ne $params.station) { $station = [int]$params.station }
            $r = Open-Act $station
            # Liveness snapshot: SM400 is always-ON while the CPU scans.
            $run = Get-DeviceValue 'SM400'
            $scan = Get-DeviceValue 'SD0'
            return @{ station = $station; reopened = [bool]$r.reopened; cpuRun = [bool]$run; scanTime = $scan }
        }
        'read' {
            $items = @($params.devices)
            if ($items.Count -eq 0) { throw 'read requires params.devices (array of device names)' }
            $out = @()
            foreach ($d in $items) {
                $out += @{ device = [string]$d; value = (Get-DeviceValue ([string]$d)) }
            }
            return @{ results = @($out) }
        }
        'write' {
            $items = @($params.items)
            if ($items.Count -eq 0) { throw 'write requires params.items (array of {device, value})' }
            $count = 0
            foreach ($it in $items) {
                Set-DeviceValue ([string]$it.device) ([int]$it.value)
                $count++
            }
            return @{ written = $count }
        }
        'status' {
            $run = Get-DeviceValue 'SM400'
            $scan = Get-DeviceValue 'SD0'
            $scanMax = Get-DeviceValue 'SD2'
            return @{ station = $script:station; cpuRun = [bool]$run; scanTime = $scan; scanTimeMax = $scanMax }
        }
        'close' {
            Close-Act
            return @{ closed = $true }
        }
        default {
            throw ('unknown op: ' + $op)
        }
    }
}

function Emit-Response($id, [bool]$ok, $result, $errorText) {
    $resp = @{ id = $id; ok = $ok }
    if ($ok) { $resp.result = $result } else { $resp.error = [string]$errorText }
    $json = ConvertTo-Json -InputObject $resp -Compress -Depth 8
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0) { continue }
    $id = $null
    try {
        $req = ConvertFrom-Json -InputObject $trimmed
        $id = $req.id
        $op = [string]$req.op
        $params = $req.params
        if ($null -eq $params) { $params = @{} }
        if ($op -eq 'exit') {
            Close-Act
            Emit-Response $id $true @{ bye = $true } $null
            break
        }
        $result = Invoke-Op $op $params
        Emit-Response $id $true $result $null
    } catch {
        Emit-Response $id $false $null $_.Exception.Message
    }
}
`
