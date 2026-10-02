using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;
using System.Diagnostics;
using System.Collections.Generic;

public static class CosWindowCapture {
    private static string EscapeJson(string value) {
        StringBuilder result = new StringBuilder();
        foreach (char ch in value) {
            if (ch == '"') result.Append("\\\"");
            else if (ch == '\\') result.Append("\\\\");
            else if (ch < 32) result.Append("\\u").Append(((int)ch).ToString("x4"));
            else result.Append(ch);
        }
        return result.ToString();
    }
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")]
    public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpfn, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    const uint DESKTOP_ENUMERATE = 0x0040;
    const uint DESKTOP_READOBJECTS = 0x0001;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
        public int Width { get { return Right - Left; } }
        public int Height { get { return Bottom - Top; } }
    }

    private static string GetProcessNameSafely(uint pid) {
        try {
            using (var p = Process.GetProcessById((int)pid)) {
                return p.ProcessName;
            }
        } catch {
            return "";
        }
    }

    public static string CaptureMatchingWindow(string query, string outPath, int maxWidth) {
        IntPtr hDesk = OpenDesktop("Default", 0, false, DESKTOP_ENUMERATE | DESKTOP_READOBJECTS);
        if (hDesk == IntPtr.Zero) {
            return "{\"ok\":false,\"error\":\"OpenDesktop Default failed (Win32 error: " + Marshal.GetLastWin32Error() + ")\"}";
        }

        IntPtr targetHwnd = IntPtr.Zero;
        string matchedTitle = "";
        uint processId = 0;
        RECT finalRect = new RECT();

        try {
            EnumDesktopWindows(hDesk, (hWnd, lParam) => {
                if (!IsWindowVisible(hWnd)) return true;

                StringBuilder sb = new StringBuilder(512);
                GetWindowText(hWnd, sb, 512);
                string title = sb.ToString();

                uint pid = 0;
                GetWindowThreadProcessId(hWnd, out pid);
                string procName = GetProcessNameSafely(pid);

                bool match = false;
                if (!string.IsNullOrEmpty(query)) {
                    if (!string.IsNullOrEmpty(title) && title.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0) match = true;
                    if (!string.IsNullOrEmpty(procName) && procName.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0) match = true;
                }

                if (match) {
                    RECT rect;
                    int hr = DwmGetWindowAttribute(hWnd, 9, out rect, Marshal.SizeOf(typeof(RECT)));
                    if (hr != 0 || rect.Width <= 10 || rect.Height <= 10) {
                        if (!GetWindowRect(hWnd, out rect) || rect.Width <= 10 || rect.Height <= 10) return true;
                    }

                    targetHwnd = hWnd;
                    matchedTitle = string.IsNullOrEmpty(title) ? ("[" + procName + " Window]") : title;
                    processId = pid;
                    finalRect = rect;
                    return false; // Found
                }

                return true;
            }, IntPtr.Zero);
        } finally {
            CloseDesktop(hDesk);
        }

        if (targetHwnd == IntPtr.Zero) {
            return "{\"ok\":false,\"error\":\"Target window matching '" + EscapeJson(query) + "' not found\"}";
        }

        string dir = Path.GetDirectoryName(outPath);
        if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) {
            Directory.CreateDirectory(dir);
        }

        int origWidth = finalRect.Width;
        int origHeight = finalRect.Height;
        int targetWidth = origWidth;
        int targetHeight = origHeight;

        if (maxWidth > 0 && origWidth > maxWidth) {
            targetWidth = maxWidth;
            targetHeight = (int)Math.Max(1, Math.Round((double)origHeight * maxWidth / origWidth));
        }

        using (Bitmap bmp = new Bitmap(origWidth, origHeight)) {
            using (Graphics g = Graphics.FromImage(bmp)) {
                IntPtr hdc = g.GetHdc();
                // PW_RENDERFULLCONTENT = 2
                bool success = PrintWindow(targetHwnd, hdc, 2);
                g.ReleaseHdc(hdc);
                if (!success) {
                    hdc = g.GetHdc();
                    PrintWindow(targetHwnd, hdc, 0);
                    g.ReleaseHdc(hdc);
                }
            }

            if (targetWidth != origWidth || targetHeight != origHeight) {
                using (Bitmap resized = new Bitmap(targetWidth, targetHeight)) {
                    using (Graphics rg = Graphics.FromImage(resized)) {
                        rg.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        rg.SmoothingMode = SmoothingMode.HighQuality;
                        rg.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        rg.DrawImage(bmp, 0, 0, targetWidth, targetHeight);
                    }
                    resized.Save(outPath, ImageFormat.Png);
                }
            } else {
                bmp.Save(outPath, ImageFormat.Png);
            }
        }

        return "{\"ok\":true,\"hwnd\":" + (long)targetHwnd + ",\"title\":\"" + EscapeJson(matchedTitle) +
               "\",\"pid\":" + processId + ",\"width\":" + targetWidth + ",\"height\":" + targetHeight + 
               ",\"origWidth\":" + origWidth + ",\"origHeight\":" + origHeight + ",\"path\":\"" + EscapeJson(outPath) + "\"}";
    }

    public static string ListWindows() {
        IntPtr hDesk = OpenDesktop("Default", 0, false, DESKTOP_ENUMERATE | DESKTOP_READOBJECTS);
        if (hDesk == IntPtr.Zero) return "[]";

        StringBuilder json = new StringBuilder("[");
        bool first = true;

        try {
            EnumDesktopWindows(hDesk, (hWnd, lParam) => {
                if (!IsWindowVisible(hWnd)) return true;

                StringBuilder sb = new StringBuilder(512);
                GetWindowText(hWnd, sb, 512);
                string title = sb.ToString();

                uint pid = 0;
                GetWindowThreadProcessId(hWnd, out pid);
                string proc = GetProcessNameSafely(pid);

                if (string.IsNullOrWhiteSpace(title) && string.IsNullOrWhiteSpace(proc)) return true;

                RECT rect;
                int hr = DwmGetWindowAttribute(hWnd, 9, out rect, Marshal.SizeOf(typeof(RECT)));
                if (hr != 0 || rect.Width <= 20 || rect.Height <= 20) {
                    if (!GetWindowRect(hWnd, out rect) || rect.Width <= 20 || rect.Height <= 20) return true;
                }

                if (!first) json.Append(",");
                first = false;

                json.Append("{")
                    .Append("\"hwnd\":").Append((long)hWnd).Append(",")
                    .Append("\"pid\":").Append(pid).Append(",")
                    .Append("\"process\":\"").Append(proc.Replace("\\", "\\\\").Replace("\"", "\\\"")).Append("\",")
                    .Append("\"title\":\"").Append(EscapeJson(title)).Append("\",")
                    .Append("\"width\":").Append(rect.Width).Append(",")
                    .Append("\"height\":").Append(rect.Height)
                    .Append("}");

                return true;
            }, IntPtr.Zero);
        } finally {
            CloseDesktop(hDesk);
        }

        json.Append("]");
        return json.ToString();
    }
}
