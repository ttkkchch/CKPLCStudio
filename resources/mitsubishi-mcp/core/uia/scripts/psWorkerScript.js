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

if (-not ('GxMsaa' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using Accessibility;
using System.Runtime.InteropServices;

// MSAA (IAccessible) bridge. GX Works3's UI is Codejock (XTP) self-drawn: the
// UIA tree has ZERO MenuItems, so menu navigation must go through IAccessible.
// Calibrated live on GX Works3 1.128J zh-CN (2026-10-01): BFS over
// AccessibleChildren + accDoDefaultAction clicks physically-unexpanded menu
// items directly.
public static class GxMsaa {
    [DllImport("oleacc.dll")]
    private static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint dwId, ref Guid iid, [In, Out] ref IAccessible ppvObject);

    [DllImport("oleacc.dll")]
    private static extern int AccessibleChildren(IAccessible paccContainer, int iChildStart, int cChildren, [Out] object[] rgvarChildren, out int pcObtained);

    public static IAccessible FromWindow(IntPtr hwnd) {
        Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
        IAccessible acc = null;
        // OBJID_WINDOW = 0xFFFFFFFC, written in decimal (PS parses 0x... as Int32 first).
        int hr = AccessibleObjectFromWindow(hwnd, 4294967292u, ref iid, ref acc);
        return hr == 0 ? acc : null;
    }

    private static string NameOf(IAccessible a, int cid) {
        try { return a.get_accName(cid) as string; } catch { return null; }
    }

    private static void EnqueueKids(IAccessible pa, Queue<KeyValuePair<IAccessible, int>> qa, Queue<string> qp, string path) {
        int n = 0;
        try { n = pa.accChildCount; } catch { return; }
        if (n <= 0) return;
        object[] kids = new object[n];
        int got;
        if (AccessibleChildren(pa, 0, n, kids, out got) != 0) return;
        for (int i = 0; i < got; i++) {
            object k = kids[i];
            if (k is int) {
                qa.Enqueue(new KeyValuePair<IAccessible, int>(pa, (int)k));
                qp.Enqueue(path + ">" + NameOf(pa, (int)k));
            } else {
                try {
                    IAccessible ka = (IAccessible)k;
                    qa.Enqueue(new KeyValuePair<IAccessible, int>(ka, 0));
                    qp.Enqueue(path + ">" + NameOf(ka, 0));
                } catch {}
            }
        }
    }

    // BFS by name prefix. minSegments filters same-caption toolbar buttons:
    // menu items live >=4 path segments deep (root>menu(C)>menu(C)>item(R))
    // while toolbar buttons sit at 2-3.
    private static string Search(IntPtr hwnd, string itemName, int minSegments, bool doClick) {
        IAccessible root = FromWindow(hwnd);
        if (root == null) return "NO-ACC";
        var qa = new Queue<KeyValuePair<IAccessible, int>>();
        var qp = new Queue<string>();
        qa.Enqueue(new KeyValuePair<IAccessible, int>(root, 0));
        qp.Enqueue("root");
        int visited = 0;
        while (qa.Count > 0 && visited < 8000) {
            var cur = qa.Dequeue();
            string path = qp.Dequeue();
            visited++;
            IAccessible pa = cur.Key;
            int cid = cur.Value;
            string name = NameOf(pa, cid);
            if (name != null && name.StartsWith(itemName, StringComparison.Ordinal)
                && path.Split('>').Length >= minSegments) {
                if (!doClick) return "FOUND " + path;
                try {
                    pa.accDoDefaultAction(cid);
                    return "CLICKED " + path;
                } catch (Exception ex) {
                    return "CLICK-ERR " + path + " : " + ex.Message;
                }
            }
            if (cid == 0) EnqueueKids(pa, qa, qp, path);
        }
        return "NOT-FOUND(" + visited + ")";
    }

    public static string FindPath(IntPtr hwnd, string itemName, int minSegments) {
        return Search(hwnd, itemName, minSegments, false);
    }

    public static string ClickItem(IntPtr hwnd, string itemName, int minSegments) {
        return Search(hwnd, itemName, minSegments, true);
    }
}
'@ -ReferencedAssemblies Accessibility.dll
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

function New-MatchCondition($names, $automationId, $controlTypes, $classNames) {
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
    if ($classNames) {
        $or = @()
        foreach ($cn in @($classNames)) {
            if ($null -eq $cn) { continue }
            $or += (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, [string]$cn))
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
            $cond = New-MatchCondition $params.names ([string]$params.automationId) $params.controlTypes $params.classNames
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
        'msaaFindPath' {
            if (-not $params.itemName) { throw 'msaaFindPath requires params.itemName' }
            $minSeg = 4
            if ($params.minSegments) { $minSeg = [int]$params.minSegments }
            $h = [IntPtr][int64]$params.rootHandle
            return @{ path = [string][GxMsaa]::FindPath($h, [string]$params.itemName, $minSeg) }
        }
        'msaaClickMenu' {
            if (-not $params.itemName) { throw 'msaaClickMenu requires params.itemName' }
            if (-not $params.rootHandle) { throw 'msaaClickMenu requires params.rootHandle' }
            $minSeg = 4
            if ($params.minSegments) { $minSeg = [int]$params.minSegments }
            $tbCls = 'XTPToolBar'
            if ($params.toolbarClassName) { $tbCls = [string]$params.toolbarClassName }
            $root = Get-RootElementFor $params.rootHandle
            # Codejock draws its own menus, so the MSAA menu bar is one of the
            # XTP* toolbars; same-caption toolbar BUTTONS sit too shallow and
            # are skipped by the minSegments filter.
            $clsCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, $tbCls)
            $bars = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $clsCond)
            $i = 0
            foreach ($b in $bars) {
                $i++
                $bh = [IntPtr]$b.Current.NativeWindowHandle
                if ($bh -eq [IntPtr]::Zero) { continue }
                $p = [GxMsaa]::FindPath($bh, [string]$params.itemName, $minSeg)
                if ($p.StartsWith('FOUND')) {
                    $c = [GxMsaa]::ClickItem($bh, [string]$params.itemName, $minSeg)
                    return @{ clicked = $c.StartsWith('CLICKED'); result = $c; path = $c; barIndex = $i; strategy = 'toolbar' }
                }
            }
            # Fallback: BFS from the window root itself (menu bar is not an XTP* toolbar).
            $h = [IntPtr][int64]$params.rootHandle
            $c2 = [GxMsaa]::ClickItem($h, [string]$params.itemName, $minSeg)
            return @{ clicked = $c2.StartsWith('CLICKED'); result = $c2; path = $c2; barIndex = 0; strategy = 'root' }
        }
        'findDialog' {
            if (-not $params.className) { throw 'findDialog requires params.className' }
            $root = Get-RootElementFor $params.rootHandle
            $clsCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, [string]$params.className)
            $visCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsOffscreenProperty, $false)
            $cond = New-Object System.Windows.Automation.AndCondition([System.Windows.Automation.Condition[]]@($clsCond, $visCond))
            $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
            $out = @()
            foreach ($d in $found) {
                $out += (ConvertTo-ElementInfo $d)
                if ($out.Count -ge 5) { break }
            }
            return @{ dialogs = @($out); total = [int]$found.Count }
        }
        'readOutputList' {
            $root = Get-RootElementFor $params.rootHandle
            $cls = 'SysListView32'
            if ($params.className) { $cls = [string]$params.className }
            $maxRows = 400
            if ($params.maxRows) { $maxRows = [int]$params.maxRows }
            $clsCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, $cls)
            $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $clsCond)
            $out = @()
            foreach ($l in $found) {
                if ($out.Count -ge 8) { break }
                $rows = $l.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
                $names = @()
                foreach ($r in $rows) {
                    if ($names.Count -ge $maxRows) { break }
                    $line = [string]$r.Current.Name
                    if (-not $line) { $line = (Get-CellText $r) }
                    $names += $line
                }
                # The Output list pairs with a SysHeader32 sibling (report view).
                $hasHeader = $false
                try {
                    $parent = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($l)
                    if ($parent) {
                        $hdrCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'SysHeader32')
                        $hasHeader = ($null -ne $parent.FindFirst([System.Windows.Automation.TreeScope]::Children, $hdrCond))
                    }
                } catch {}
                $out += @{ rowCount = [int]$rows.Count; rows = @($names); hasHeader = $hasHeader }
            }
            return @{ lists = @($out) }
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
