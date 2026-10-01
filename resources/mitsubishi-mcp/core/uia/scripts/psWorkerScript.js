"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PS_WORKER_SCRIPT = void 0;
/**
 * Inline PowerShell 5.1 worker script for the GX Works3 UIA bridge.
 *
 * Materialized to a temp .ps1 and run by PsWorker (`-File`). Protocol is NDJSON
 * over stdio:
 *
 *   request  → {"id":<number|string>,"op":"<name>","params":{...}}
 *   response ← {"id":...,"ok":true,"result":{...}} | {"id":...,"ok":false,"error":"..."}
 *
 * The script is pure UIA2 (System.Windows.Automation) + user32 P/Invoke +
 * WinForms clipboard/SendKeys — no external modules. PowerShell 5.1 runs STA
 * by default, which the clipboard requires.
 *
 * NOTE: this constant must stay a template literal WITHOUT `${` sequences or
 * backticks in the PowerShell/C# code — plain `$var` interpolation is fine.
 */
exports.PS_WORKER_SCRIPT = `# gx-uia-worker - resident UIA worker for the CKPLCStudio GX Works3 bridge.
# NDJSON protocol over stdio; exits on stdin EOF or the "exit" op.
$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null
Add-Type -AssemblyName System.Windows.Forms | Out-Null

if (-not ('GxNative' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class GxNative {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int maxCount);
    public static string ClassNameOf(IntPtr hWnd) { var sb = new StringBuilder(256); return GetClassName(hWnd, sb, 256) > 0 ? sb.ToString() : ""; }
}
'@
}

function ConvertTo-ElementInfo($el) {
    $c = $el.Current
    $info = @{
        name = [string]$c.Name
        automationId = [string]$c.AutomationId
        controlType = ([string]$c.ControlType.ProgrammaticName) -replace '^ControlType.', ''
        className = [string]$c.ClassName
        enabled = [bool]$c.IsEnabled
        processId = [int]$c.ProcessId
    }
    if ($c.NativeWindowHandle -ne 0) { $info.handle = [int64]$c.NativeWindowHandle }
    return $info
}

function Get-ControlType([string]$name) {
    $t = [System.Windows.Automation.ControlType]
    switch ($name) {
        'Window'    { return $t::Window }
        'Pane'      { return $t::Pane }
        'MenuItem'  { return $t::MenuItem }
        'Button'    { return $t::Button }
        'Document'  { return $t::Document }
        'Edit'      { return $t::Edit }
        'Text'      { return $t::Text }
        'TabItem'   { return $t::TabItem }
        'DataGrid'  { return $t::DataGrid }
        'Table'     { return $t::Table }
        'Custom'    { return $t::Custom }
        'List'      { return $t::List }
        'ListItem'  { return $t::ListItem }
        'Tree'      { return $t::Tree }
        'TreeItem'  { return $t::TreeItem }
        'ComboBox'  { return $t::ComboBox }
        'Group'     { return $t::Group }
        default     { return $null }
    }
}

function New-MatchCondition($names, $automationId, $controlTypes) {
    $groups = @()
    if ($names) {
        $or = @()
        foreach ($n in @($names)) {
            if ($null -eq $n) { continue }
            $or += (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, [string]$n))
        }
        if ($or.Count -eq 1) { $groups += $or[0] }
        elseif ($or.Count -gt 1) { $groups += (New-Object System.Windows.Automation.OrCondition([System.Windows.Automation.Condition[]]$or)) }
    }
    if ($automationId) {
        $groups += (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$automationId))
    }
    if ($controlTypes) {
        $or = @()
        foreach ($ct in @($controlTypes)) {
            $resolved = Get-ControlType ([string]$ct)
            if ($null -ne $resolved) {
                $or += (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $resolved))
            }
        }
        if ($or.Count -eq 1) { $groups += $or[0] }
        elseif ($or.Count -gt 1) { $groups += (New-Object System.Windows.Automation.OrCondition([System.Windows.Automation.Condition[]]$or)) }
    }
    if ($groups.Count -eq 0) { return [System.Windows.Automation.Condition]::TrueCondition }
    if ($groups.Count -eq 1) { return $groups[0] }
    return (New-Object System.Windows.Automation.AndCondition([System.Windows.Automation.Condition[]]$groups))
}

function Get-RootElementFor($handle) {
    if ($handle) {
        $h = [IntPtr][int64]$handle
        if ([GxNative]::IsWindow($h)) {
            return [System.Windows.Automation.AutomationElement]::FromHandle($h)
        }
        throw ('window handle is no longer valid: ' + $handle)
    }
    return [System.Windows.Automation.AutomationElement]::RootElement
}

function Find-FirstElement($root, $names, $automationId, $controlTypes) {
    $cond = New-MatchCondition $names $automationId $controlTypes
    $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($found.Count -gt 0) { return $found[0] }
    return $null
}

function Find-GxWindows([string]$titleContains) {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    $out = @()
    foreach ($el in $all) {
        $c = $el.Current
        $ct = ([string]$c.ControlType.ProgrammaticName) -replace '^ControlType.', ''
        if ($ct -ne 'Window') { continue }
        if ($titleContains -and ($c.Name -notlike ('*' + $titleContains + '*'))) { continue }
        $out += (ConvertTo-ElementInfo $el)
        if ($out.Count -ge 30) { break }
    }
    # Comma prefix: keep a single-element array from unrolling in the pipeline.
    return ,$out
}

function Get-CellText($cell) {
    $n = $cell.Current.Name
    if ($n) { return [string]$n }
    $parts = @()
    $desc = $cell.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($d in $desc) {
        $dn = $d.Current.Name
        if ($dn) { $parts += [string]$dn }
        if ($parts.Count -ge 8) { break }
    }
    return ($parts -join ' ')
}

function Set-ClipboardText([string]$text) {
    for ($i = 0; $i -lt 6; $i++) {
        try {
            [System.Windows.Forms.Clipboard]::SetText($text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
            return $true
        } catch { Start-Sleep -Milliseconds 120 }
    }
    throw 'clipboard SetText failed (busy or non-STA apartment)'
}

function Get-ClipboardText {
    for ($i = 0; $i -lt 6; $i++) {
        try { return [string][System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText) }
        catch { Start-Sleep -Milliseconds 120 }
    }
    throw 'clipboard GetText failed (busy or non-STA apartment)'
}

function Invoke-Op([string]$op, $params) {
    switch ($op) {
        'ping' {
            return @{ pid = $PID; version = 1; sta = [string][System.Threading.Thread]::CurrentThread.GetApartmentState() }
        }
        'findWindow' {
            $title = [string]$params.titleContains
            return @{ windows = @((Find-GxWindows $title)) }
        }
        'setForeground' {
            if (-not $params.handle) { throw 'setForeground requires params.handle' }
            $h = [IntPtr][int64]$params.handle
            if (-not [GxNative]::IsWindow($h)) { throw ('window handle is no longer valid: ' + $params.handle) }
            if ([GxNative]::IsIconic($h)) { [void][GxNative]::ShowWindow($h, 9) }
            $ok = [GxNative]::SetForegroundWindow($h)
            Start-Sleep -Milliseconds 120
            return @{ foregrounded = [bool]$ok; nowForeground = ([GxNative]::GetForegroundWindow() -eq $h) }
        }
        'getForeground' {
            $h = [GxNative]::GetForegroundWindow()
            if ($h -eq [IntPtr]::Zero) { return @{ handle = $null } }
            $info = ConvertTo-ElementInfo ([System.Windows.Automation.AutomationElement]::FromHandle($h))
            return @{ handle = [int64]$h; info = $info }
        }
        'findElements' {
            $root = Get-RootElementFor $params.rootHandle
            $cond = New-MatchCondition $params.names ([string]$params.automationId) $params.controlTypes
            $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
            $max = 30
            if ($params.maxResults) { $max = [int]$params.maxResults }
            $out = @()
            foreach ($el in $found) {
                $out += (ConvertTo-ElementInfo $el)
                if ($out.Count -ge $max) { break }
            }
            return @{ elements = @($out); total = [int]$found.Count }
        }
        'listChildren' {
            $root = Get-RootElementFor $params.rootHandle
            $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
            $out = @()
            foreach ($el in $all) {
                $out += (ConvertTo-ElementInfo $el)
                if ($out.Count -ge 200) { break }
            }
            return @{ elements = @($out); total = [int]$all.Count }
        }
        'focusElement' {
            $root = Get-RootElementFor $params.rootHandle
            $el = Find-FirstElement $root $params.names ([string]$params.automationId) $params.controlTypes
            if ($null -eq $el) { throw 'element not found (focusElement)' }
            $el.SetFocus()
            Start-Sleep -Milliseconds 120
            return @{ focused = (ConvertTo-ElementInfo $el) }
        }
        'invokeElement' {
            $root = Get-RootElementFor $params.rootHandle
            $el = Find-FirstElement $root $params.names ([string]$params.automationId) $params.controlTypes
            if ($null -eq $el) { throw 'element not found (invokeElement)' }
            try {
                ($el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
                return @{ pattern = 'invoke'; invoked = (ConvertTo-ElementInfo $el) }
            } catch {}
            try {
                ($el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Select()
                return @{ pattern = 'selectionItem'; invoked = (ConvertTo-ElementInfo $el) }
            } catch {}
            try {
                ($el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)).Expand()
                return @{ pattern = 'expandCollapse'; invoked = (ConvertTo-ElementInfo $el) }
            } catch {}
            throw 'element has no invokable pattern (invoke/selectionItem/expandCollapse)'
        }
        'clipboardWrite' {
            $count = Set-ClipboardText ([string]$params.text)
            return @{ written = [bool]$count }
        }
        'clipboardRead' {
            return @{ text = (Get-ClipboardText) }
        }
        'sendKeys' {
            if ($null -eq $params.keys) { throw 'sendKeys requires params.keys' }
            [System.Windows.Forms.SendKeys]::SendWait([string]$params.keys)
            Start-Sleep -Milliseconds 80
            return @{ sent = [string]$params.keys }
        }
        'readGrid' {
            $root = Get-RootElementFor $params.rootHandle
            $grid = $null
            if ($params.paneNames) {
                # Two-level search: locate the pane by name, then the grid inside it.
                $pane = Find-FirstElement $root $params.paneNames $null @('Window', 'Pane')
                if ($pane) { $grid = Find-FirstElement $pane $params.names ([string]$params.automationId) $params.gridControlTypes }
            }
            if ($null -eq $grid) {
                $grid = Find-FirstElement $root $params.names ([string]$params.automationId) $params.controlTypes
            }
            if ($null -eq $grid) { throw 'grid element not found (readGrid)' }
            $rows = $grid.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
            $max = 200
            if ($params.maxRows) { $max = [int]$params.maxRows }
            $out = @()
            foreach ($row in $rows) {
                if ($out.Count -ge $max) { break }
                $line = [string]$row.Current.Name
                if (-not $line) {
                    $texts = @()
                    $cells = $row.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
                    foreach ($cell in $cells) {
                        $t = Get-CellText $cell
                        if ($t) { $texts += $t }
                    }
                    $line = ($texts -join ' | ')
                }
                $out += $line
            }
            return @{ rows = @($out); rowCount = $out.Count }
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
            Emit-Response $id $true @{ bye = $true } $null
            break
        }
        $result = Invoke-Op $op $params
        Emit-Response $id $true $result $null
    } catch {
        Emit-Response $id $false $null $_.Exception.Message
    }
}
`;
