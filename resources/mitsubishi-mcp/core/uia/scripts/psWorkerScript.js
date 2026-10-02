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
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class GxNative {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int maxCount);
    public static string ClassNameOf(IntPtr hWnd) { var sb = new StringBuilder(256); return GetClassName(hWnd, sb, 256) > 0 ? sb.ToString() : ""; }
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int maxCount);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc cb, IntPtr lp);

    // Direct Win32 child scan by class — the FAST route for native controls
    // (XTPToolBar etc.). UIA FindAll(Descendants) over a GX Works frame costs
    // >45s cold (whole-tree cross-process walk); EnumChildWindows is O(children)
    // and returns identical hwnds. Window text == UIA Name for XTP toolbars
    // (verified live 2026-10-02 on works3 菜单栏 and works2 菜单栏).
    public static List<KeyValuePair<long, string>> ChildWindowsOf(IntPtr root, string className) {
        var found = new List<KeyValuePair<long, string>>();
        EnumChildWindows(root, delegate(IntPtr h, IntPtr lp) {
            var cn = new StringBuilder(256);
            if (GetClassName(h, cn, 256) <= 0 || cn.ToString() != className) return true;
            var tt = new StringBuilder(512);
            GetWindowText(h, tt, 512);
            found.Add(new KeyValuePair<long, string>(h.ToInt64(), tt.ToString()));
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // Owned dialogs of GX Works2's build confirm are TOP-LEVEL windows (not
    // main-window children), invisible to a UIA Descendants search from the
    // frame. Scan top-level windows of the SAME process by class name instead.
    public static List<KeyValuePair<long, string>> TopDialogsOf(IntPtr main, uint pid, string className) {
        var found = new List<KeyValuePair<long, string>>();
        EnumWindows(delegate(IntPtr h, IntPtr lp) {
            if (!IsWindowVisible(h)) return true;
            var cn = new StringBuilder(256);
            if (GetClassName(h, cn, 256) <= 0 || cn.ToString() != className) return true;
            uint wpid = 0;
            GetWindowThreadProcessId(h, out wpid);
            if (wpid != pid) return true;
            var tt = new StringBuilder(512);
            if (GetWindowText(h, tt, 512) <= 0) return true;
            found.Add(new KeyValuePair<long, string>(h.ToInt64(), tt.ToString()));
            return true;
        }, IntPtr.Zero);
        return found;
    }

    [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] public static extern IntPtr VirtualAllocEx(IntPtr proc, IntPtr addr, IntPtr size, uint type, uint protect);
    [DllImport("kernel32.dll")] public static extern bool VirtualFreeEx(IntPtr proc, IntPtr addr, IntPtr size, uint freeType);
    [DllImport("kernel32.dll")] public static extern bool WriteProcessMemory(IntPtr proc, IntPtr addr, byte[] buf, IntPtr size, out IntPtr written);
    [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr proc, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

    public class LvListResult {
        public long hwnd;
        public bool hasHeader;
        public List<string> Rows = new List<string>();
    }

    // Cross-process SysListView32 reader for the works3 output list. The list's
    // visible rows are painted from app storage: UIA names, MSAA names and even
    // LVM with an x64 LVITEMW all come back EMPTY because GXW3.exe is a 32-bit
    // WOW64 process — only the x86 LVITEMW layout (60 bytes, 32-bit pszText)
    // returns real cells. Rows join "cell | cell" mirroring the works2
    // msaa-grid rows. Calibrated live 2026-10-02 (works3 1.128J zh-CN):
    // "1 | Error | ProgPou | 转换程序 | 语法有误。请确认错误前后的语法。 | 0x110E1A02".
    public static List<LvListResult> LvListsOf(IntPtr root, string className, int maxRows) {
        var lists = new List<LvListResult>();
        EnumChildWindows(root, delegate(IntPtr h, IntPtr lp) {
            var cn = new StringBuilder(256);
            if (GetClassName(h, cn, 256) <= 0 || cn.ToString() != className) return true;
            if (!IsWindowVisible(h)) return true;
            RECT r; GetWindowRect(h, out r);
            if ((r.R - r.L) <= 50 || (r.B - r.T) <= 30) return true;
            var res = new LvListResult();
            res.hwnd = h.ToInt64();
            IntPtr hdr = SendMessageW(h, 0x1000 + 31, IntPtr.Zero, IntPtr.Zero); // LVM_GETHEADER
            res.hasHeader = hdr != IntPtr.Zero;
            int rows = (int)SendMessageW(h, 0x1000 + 4, IntPtr.Zero, IntPtr.Zero).ToInt64(); // LVM_GETITEMCOUNT
            int cols = 1;
            if (hdr != IntPtr.Zero) cols = (int)SendMessageW(hdr, 0x1200, IntPtr.Zero, IntPtr.Zero).ToInt64(); // HDM_GETITEMCOUNT
            if (cols <= 0) cols = 1;
            if (rows > maxRows) rows = maxRows;
            uint pid = 0;
            GetWindowThreadProcessId(h, out pid);
            IntPtr proc = OpenProcess(0x1F0FFF, false, pid);
            if (proc == IntPtr.Zero) { lists.Add(res); return true; }
            try {
                int structSize = 60; // x86 LVITEMW
                IntPtr remote = VirtualAllocEx(proc, IntPtr.Zero, (IntPtr)(structSize + 4096), 0x3000, 0x04);
                if (remote != IntPtr.Zero) {
                    try {
                        for (int row = 0; row < rows; row++) {
                            var parts = new List<string>();
                            for (int col = 0; col < cols; col++) {
                                var local = new byte[structSize];
                                byte[] num = BitConverter.GetBytes(1); // LVIF_TEXT
                                Array.Copy(num, 0, local, 0, 4);
                                num = BitConverter.GetBytes(row);
                                Array.Copy(num, 0, local, 4, 4);
                                num = BitConverter.GetBytes((uint)col);
                                Array.Copy(num, 0, local, 8, 4);
                                num = BitConverter.GetBytes((uint)(remote.ToInt64() + structSize));
                                Array.Copy(num, 0, local, 20, 4);
                                num = BitConverter.GetBytes(1000);
                                Array.Copy(num, 0, local, 24, 4);
                                IntPtr wr;
                                string cell = "";
                                if (WriteProcessMemory(proc, remote, local, (IntPtr)structSize, out wr)) {
                                    SendMessageW(h, 0x1000 + 115, (IntPtr)row, remote); // LVM_GETITEMTEXTW
                                    var textBuf = new byte[4096];
                                    if (ReadProcessMemory(proc, (IntPtr)(remote.ToInt64() + structSize), textBuf, (IntPtr)4096, out wr)) {
                                        cell = Encoding.Unicode.GetString(textBuf);
                                        int z = cell.IndexOf('\\0');
                                        if (z >= 0) cell = cell.Substring(0, z);
                                    }
                                }
                                parts.Add(cell);
                            }
                            res.Rows.Add(string.Join(" | ", parts));
                        }
                    } finally { VirtualFreeEx(proc, remote, IntPtr.Zero, 0x8000); }
                }
            } finally { CloseHandle(proc); }
            lists.Add(res);
            return true;
        }, IntPtr.Zero);
        return lists;
    }
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

    // VSFlexGrid8N output grid (GX Works2, calibrated live 2026-10-01): the
    // MSAA root is a LIST whose children are header LISTITEMs (childCount 0)
    // plus Row-N PAGETABs owning PROPERTYPAGE cells whose accValue carries the
    // text. Rows are joined "cell | cell" skipping empty cells, e.g.
    // "1 | Error | POU_01 | 编译程序 | 没有找到算式。 | C8042".
    public static List<string> GridRows(IntPtr hwnd, int maxRows) {
        var rowsOut = new List<string>();
        IAccessible root = FromWindow(hwnd);
        if (root == null) return rowsOut;
        int n = 0;
        try { n = root.accChildCount; } catch {}
        if (n <= 0) return rowsOut;
        object[] kids = new object[n];
        int got;
        if (AccessibleChildren(root, 0, n, kids, out got) != 0) return rowsOut;
        for (int i = 0; i < got && rowsOut.Count < maxRows; i++) {
            IAccessible row = kids[i] as IAccessible;
            if (row == null) continue;
            int rc = 0;
            try { rc = row.accChildCount; } catch {}
            if (rc <= 0) continue; // header LISTITEMs carry no children
            object[] cells = new object[rc];
            int cgot;
            if (AccessibleChildren(row, 0, rc, cells, out cgot) != 0) continue;
            var parts = new List<string>();
            for (int j = 0; j < cgot; j++) {
                IAccessible cell = cells[j] as IAccessible;
                if (cell == null) continue;
                string v = null;
                try { v = cell.get_accValue(0) as string; } catch {}
                if (!string.IsNullOrEmpty(v)) parts.Add(v);
            }
            rowsOut.Add(string.Join(" | ", parts.ToArray()));
        }
        return rowsOut;
    }

    // Depth-1 child names of the MSAA root. The works2 PLC写入 dialog (a plain
    // MFC #32770) exposes its progress as depth-1 child accNames like
    // "52/100%" — no tree walk needed (calibrated probe_w2_31, 2026-10-01).
    public static List<string> ChildNames(IntPtr hwnd) {
        var names = new List<string>();
        IAccessible root = FromWindow(hwnd);
        if (root == null) return names;
        int n = 0;
        try { n = root.accChildCount; } catch {}
        if (n <= 0) return names;
        object[] kids = new object[n];
        int got;
        if (AccessibleChildren(root, 0, n, kids, out got) != 0) return names;
        for (int i = 0; i < got; i++) {
            IAccessible ka = kids[i] as IAccessible;
            if (ka == null) continue;
            string v = null;
            try { v = ka.get_accName(0) as string; } catch {}
            if (!string.IsNullOrEmpty(v)) names.Add(v);
        }
        return names;
    }

    // BFS click on a PUSHBUTTON (MSAA role 43) whose name starts with the
    // prefix — calibrated on the works2 PLC写入 dialog's 关闭 button
    // (probe_w2_31, 2026-10-01).
    public static string ClickPushButton(IntPtr hwnd, string namePrefix) {
        IAccessible root = FromWindow(hwnd);
        if (root == null) return "NO-ACC";
        var qa = new Queue<KeyValuePair<IAccessible, int>>();
        var qp = new Queue<string>();
        qa.Enqueue(new KeyValuePair<IAccessible, int>(root, 0));
        qp.Enqueue("D");
        int visited = 0;
        while (qa.Count > 0 && visited < 600) {
            var cur = qa.Dequeue();
            string path = qp.Dequeue();
            visited++;
            IAccessible pa = cur.Key;
            int cid = cur.Value;
            string name = NameOf(pa, cid);
            int role = 0;
            try { role = Convert.ToInt32(pa.get_accRole(cid)); } catch {}
            if (role == 43 && name != null && name.StartsWith(namePrefix, StringComparison.Ordinal)) {
                try {
                    pa.accDoDefaultAction(cid);
                    return "CLICKED " + path + " [" + name + "]";
                } catch (Exception ex) {
                    return "CLICK-ERR " + path + " : " + ex.Message;
                }
            }
            if (cid == 0) EnqueueKids(pa, qa, qp, path);
        }
        return "NOT-FOUND(" + visited + ")";
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

function Find-FirstElement($root, $names, $automationId, $controlTypes, $classNames) {
    $cond = New-MatchCondition $names $automationId $controlTypes $classNames
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

# Titled top-level dialogs of the SAME process as $handle (owned dialogs never
# appear under the owner in a UIA Descendants search).
function Find-TopLevelDialogs($handle, [string]$cls) {
    $h = [IntPtr][int64]$handle
    $mainPid = [uint32]0
    [void][GxNative]::GetWindowThreadProcessId($h, [ref]$mainPid)
    $tops = [GxNative]::TopDialogsOf($h, $mainPid, $cls)
    $out = @()
    foreach ($t in $tops) {
        $out += @{ name = [string]$t.Value; automationId = ''; controlType = 'Window'; className = $cls; enabled = $true; handle = [int64]$t.Key }
        if ($out.Count -ge 5) { break }
    }
    return ,$out
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
            if (-not $ok -or [GxNative]::GetForegroundWindow() -ne $h) {
                # Windows foreground lock: a background process may not steal
                # focus (observed live 2026-10-02 when the user browses in a
                # browser while the bridge runs). Classic bypass — attach our
                # input queue to the foreground thread so the OS treats this
                # thread as the active input context, then steal foreground.
                Start-Sleep -Milliseconds 80
                $fgNow = [GxNative]::GetForegroundWindow()
                $scratch = [uint32]0
                $fgThread = [GxNative]::GetWindowThreadProcessId($fgNow, [ref]$scratch)
                $myThread = [GxNative]::GetCurrentThreadId()
                $attached = $false
                if ($fgThread -ne 0 -and $fgThread -ne $myThread) {
                    $attached = [GxNative]::AttachThreadInput($myThread, $fgThread, $true)
                }
                try {
                    [void][GxNative]::BringWindowToTop($h)
                    $ok = [GxNative]::SetForegroundWindow($h)
                } finally {
                    if ($attached) { [void][GxNative]::AttachThreadInput($myThread, $fgThread, $false) }
                }
            }
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
            $el = Find-FirstElement $root $params.names ([string]$params.automationId) $params.controlTypes $params.classNames
            if ($null -eq $el) { throw 'element not found (focusElement)' }
            $el.SetFocus()
            Start-Sleep -Milliseconds 120
            return @{ focused = (ConvertTo-ElementInfo $el) }
        }
        'getFocusedElement' {
            $el = [System.Windows.Automation.AutomationElement]::FocusedElement
            if ($null -eq $el) { return @{ info = $null } }
            return @{ info = (ConvertTo-ElementInfo $el) }
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
            # Optional exact-name filter for the ONE toolbar that is the menu
            # bar (works2 sim-start: 菜单栏). Other toolbars carry same-caption
            # buttons (模拟开始 etc.) that a class-only filter would click.
            $mbName = $null
            if ($params.menuBarName) { $mbName = [string]$params.menuBarName }
            $h = [IntPtr][int64]$params.rootHandle
            # FAST route (default): EnumChildWindows class scan — O(children),
            # no UIA tree walk. Window text == UIA Name for XTP toolbars
            # (verified live works3+works2 2026-10-02). The UIA FindAll below
            # is kept only as a defensive fallback for shells whose menu bar
            # is NOT a frame descendant in Win32 terms.
            $barsFast = [GxNative]::ChildWindowsOf($h, $tbCls)
            $i = 0
            foreach ($b in $barsFast) {
                $i++
                if ($mbName -and ($b.Value -ne $mbName)) { continue }
                $bh = [IntPtr]$b.Key
                if ($bh -eq [IntPtr]::Zero) { continue }
                $p = [GxMsaa]::FindPath($bh, [string]$params.itemName, $minSeg)
                if ($p.StartsWith('FOUND')) {
                    $c = [GxMsaa]::ClickItem($bh, [string]$params.itemName, $minSeg)
                    return @{ clicked = $c.StartsWith('CLICKED'); result = $c; path = $c; barIndex = $i; strategy = 'toolbar' }
                }
            }
            if ($barsFast.Count -gt 0 -or $mbName) {
                if ($mbName) {
                    # No root fallback when the caller pinned the menu bar — a BFS
                    # from the window root would hit the very toolbar buttons the
                    # filter exists to avoid.
                    $miss = 'NOT-FOUND(menu-bar "' + $mbName + '")'
                    return @{ clicked = $false; result = $miss; path = $miss; barIndex = 0; strategy = 'toolbar' }
                }
                # class scan found toolbars but none carried the item — no point
                # re-scanning via UIA; go straight to the root fallback below.
                $c3 = [GxMsaa]::ClickItem($h, [string]$params.itemName, $minSeg)
                return @{ clicked = $c3.StartsWith('CLICKED'); result = $c3; path = $c3; barIndex = 0; strategy = 'root' }
            }
            # SLOW fallback: UIA descendants scan for the toolbar class.
            $root = Get-RootElementFor $params.rootHandle
            $clsCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, $tbCls)
            $bars = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $clsCond)
            $i = 0
            foreach ($b in $bars) {
                $i++
                if ($mbName -and ([string]$b.Current.Name -ne $mbName)) { continue }
                $bh = [IntPtr]$b.Current.NativeWindowHandle
                if ($bh -eq [IntPtr]::Zero) { continue }
                $p = [GxMsaa]::FindPath($bh, [string]$params.itemName, $minSeg)
                if ($p.StartsWith('FOUND')) {
                    $c = [GxMsaa]::ClickItem($bh, [string]$params.itemName, $minSeg)
                    return @{ clicked = $c.StartsWith('CLICKED'); result = $c; path = $c; barIndex = $i; strategy = 'toolbar-uia' }
                }
            }
            if ($mbName) {
                $miss = 'NOT-FOUND(menu-bar "' + $mbName + '")'
                return @{ clicked = $false; result = $miss; path = $miss; barIndex = 0; strategy = 'toolbar-uia' }
            }
            # Fallback: BFS from the window root itself (menu bar is not an XTP* toolbar).
            $c2 = [GxMsaa]::ClickItem($h, [string]$params.itemName, $minSeg)
            return @{ clicked = $c2.StartsWith('CLICKED'); result = $c2; path = $c2; barIndex = 0; strategy = 'root' }
        }
        'dialogProgress' {
            if (-not $params.handle) { throw 'dialogProgress requires params.handle' }
            $names = [GxMsaa]::ChildNames([IntPtr][int64]$params.handle)
            return @{ texts = @($names) }
        }
        'clickDialogButton' {
            if (-not $params.handle) { throw 'clickDialogButton requires params.handle' }
            if (-not $params.name) { throw 'clickDialogButton requires params.name' }
            $r = [GxMsaa]::ClickPushButton([IntPtr][int64]$params.handle, [string]$params.name)
            return @{ clicked = $r.StartsWith('CLICKED'); result = $r }
        }
        'findProcess' {
            $running = @()
            foreach ($n in @($params.names)) {
                $p = Get-Process -Name ([string]$n) -ErrorAction SilentlyContinue
                if ($p) { $running += @{ name = [string]$n; pid = [int](@($p)[0].Id) } }
            }
            return @{ running = @($running) }
        }
        'stopProcess' {
            $killed = @()
            $missing = @()
            foreach ($n in @($params.names)) {
                $p = Get-Process -Name ([string]$n) -ErrorAction SilentlyContinue
                if ($p) {
                    $pids = (@($p) | ForEach-Object { [string]$_.Id }) -join ','
                    @($p) | Stop-Process -Force
                    $killed += ("{0}({1})" -f ([string]$n), $pids)
                } else {
                    $missing += [string]$n
                }
            }
            return @{ killed = @($killed); missing = @($missing) }
        }
        'findDialog' {
            if (-not $params.className) { throw 'findDialog requires params.className' }
            $search = 'child'
            if ($params.search) { $search = [string]$params.search }
            $out = @()
            $total = 0
            if ($search -ne 'top-level') {
                $root = Get-RootElementFor $params.rootHandle
                $clsCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, [string]$params.className)
                $visCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsOffscreenProperty, $false)
                $cond = New-Object System.Windows.Automation.AndCondition([System.Windows.Automation.Condition[]]@($clsCond, $visCond))
                $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
                $total = [int]$found.Count
                foreach ($d in $found) {
                    $out += (ConvertTo-ElementInfo $d)
                    if ($out.Count -ge 5) { break }
                }
                if ($out.Count -eq 0) {
                    # Works2's build-confirm dialog is an OWNED TOP-LEVEL window,
                    # so a UIA Descendants search under the frame never sees it.
                    # Scan same-process top-level windows by class name instead.
                    $out = Find-TopLevelDialogs $params.rootHandle ([string]$params.className)
                }
            } else {
                # Works2 (calibrated live 2026-10-01): the main frame keeps
                # EMPTY-TITLED child #32770 MDI containers around, so a UIA
                # descendants search hits those first and ENTER would land in
                # the wrong window. The confirm dialog is always the one titled
                # top-level #32770 of the process — search that channel ONLY.
                $out = Find-TopLevelDialogs $params.rootHandle ([string]$params.className)
            }
            return @{ dialogs = @($out); total = $total }
        }
        'closeTopDialogs' {
            if (-not $params.rootHandle) { throw 'closeTopDialogs requires params.rootHandle' }
            $cls = '#32770'
            if ($params.className) { $cls = [string]$params.className }
            $rootH = [IntPtr][int64]$params.rootHandle
            [uint32]$pidWin = 0
            [void][GxNative]::GetWindowThreadProcessId($rootH, [ref]$pidWin)
            $strays = [GxNative]::TopDialogsOf($rootH, $pidWin, $cls)
            $titles = @()
            foreach ($s in @($strays)) {
                $h = [IntPtr][int64]$s.Key
                # WM_CLOSE = 取消 semantics on the compile-confirm dialogs.
                [void][GxNative]::SendMessageW($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
                $titles += [string]$s.Value
            }
            return @{ closed = [int]$titles.Count; titles = @($titles) }
        }
        'readOutputList' {
            $cls = 'SysListView32'
            if ($params.className) { $cls = [string]$params.className }
            $reader = 'uia-list'
            if ($params.reader) { $reader = [string]$params.reader }
            $maxRows = 400
            if ($params.maxRows) { $maxRows = [int]$params.maxRows }
            if ($reader -eq 'lvm') {
                # Works3 output list: a UIA FindAll over the frame tree stalls
                # >45s and the list's UIA/MSAA names are empty anyway (rows are
                # app-painted). Win32 locate + cross-process x86-layout LVM is
                # O(children) milliseconds (calibrated live 2026-10-02).
                $lists = [GxNative]::LvListsOf([IntPtr][int64]$params.rootHandle, $cls, $maxRows)
                $out = @()
                foreach ($l in $lists) {
                    $out += @{ rowCount = [int]$l.Rows.Count; rows = @($l.Rows); hasHeader = [bool]$l.hasHeader }
                }
                return @{ lists = @($out) }
            }
            $root = Get-RootElementFor $params.rootHandle
            $clsCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, $cls)
            $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $clsCond)
            $out = @()
            foreach ($l in $found) {
                if ($out.Count -ge 8) { break }
                if ($reader -eq 'msaa-grid') {
                    # Works2 VSFlexGrid8N: an MSAA-only ActiveX grid whose row
                    # text lives in cell accValue, invisible to UIA names. The
                    # grid hwnd is read directly through GxMsaa (calibrated).
                    $gw = [IntPtr]$l.Current.NativeWindowHandle
                    if ($gw -eq [IntPtr]::Zero) { continue }
                    $gridRows = [GxMsaa]::GridRows($gw, $maxRows)
                    $out += @{ rowCount = [int]$gridRows.Count; rows = @($gridRows); hasHeader = $false }
                    continue
                }
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
