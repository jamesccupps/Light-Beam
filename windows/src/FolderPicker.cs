// Windows' own folder picker (the one with an address bar: a path like %APPDATA%\edvrclient can be typed or pasted, and
// hidden folders such as AppData are shown), for Log folders… (app 1.34; the user, 2026-11-23: "the add log folders
// doesnt let me actually add anything that doesnt show like appdata folders"). The old tree (FolderBrowserDialog) only
// if this one can't be made.
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Beam
{
    static class FolderPicker
    {
        [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
        class FileOpenDialogCom { }

        [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IFileDialog
        {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes(uint count, IntPtr specs);
            void SetFileTypeIndex(uint index);
            void GetFileTypeIndex(out uint index);
            void Advise(IntPtr events, out uint cookie);
            void Unadvise(uint cookie);
            void SetOptions(uint options);
            void GetOptions(out uint options);
            void SetDefaultFolder(IShellItem item);
            void SetFolder(IShellItem item);
            void GetFolder(out IShellItem item);
            void GetCurrentSelection(out IShellItem item);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
            void GetResult(out IShellItem item);
            void AddPlace(IShellItem item, int where);
            void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string ext);
            void Close(int hr);
            void SetClientGuid(ref Guid guid);
            void ClearClientData();
            void SetFilter(IntPtr filter);
        }

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItem
        {
            void BindToHandler(IntPtr bc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
            void GetParent(out IShellItem parent);
            void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
            void GetAttributes(uint mask, out uint attribs);
            void Compare(IShellItem other, uint hint, out int order);
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        static extern void SHCreateItemFromParsingName(string path, IntPtr bc, ref Guid riid, out IShellItem item);

        const uint PickFolders = 0x20, ForceFileSystem = 0x40, NoChangeDir = 0x8, PathMustExist = 0x800, ForceShowHidden = 0x10000000;
        const uint SigdnFileSysPath = 0x80058000;
        const int Cancelled = unchecked((int)0x800704C7);

        // The folder picked (its full path), or null when cancelled. `start`: where it opens (else where it was last).
        public static string Pick(IWin32Window owner, string title, string start)
        {
            IFileDialog dlg = null;
            try { dlg = (IFileDialog)new FileOpenDialogCom(); }
            catch (Exception ex) { Log.Write("Folder picker: Windows' own isn't there (" + ex.Message + "), the old one instead"); return PickOld(owner, title); }
            try
            {
                uint options;
                dlg.GetOptions(out options);
                dlg.SetOptions(options | PickFolders | ForceFileSystem | NoChangeDir | PathMustExist | ForceShowHidden);
                if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);
                if (!string.IsNullOrEmpty(start))
                {
                    try
                    {
                        var iid = typeof(IShellItem).GUID;
                        IShellItem folder;
                        SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out folder);
                        if (folder != null) dlg.SetFolder(folder);
                    }
                    catch { }
                }
                int hr = dlg.Show(owner != null ? owner.Handle : IntPtr.Zero);
                if (hr == Cancelled) return null;
                if (hr != 0) Marshal.ThrowExceptionForHR(hr);
                IShellItem result;
                dlg.GetResult(out result);
                string path;
                result.GetDisplayName(SigdnFileSysPath, out path);
                return path;
            }
            finally { Marshal.FinalReleaseComObject(dlg); }
        }

        // (tests) The dialog made and set up as Pick does (its options, title and start folder read back), never shown:
        // a wrong COM layout fails here instead of at the user's click. Null, or what went wrong.
        public static string Probe(string start)
        {
            IFileDialog dlg = null;
            try
            {
                dlg = (IFileDialog)new FileOpenDialogCom();
                uint options;
                dlg.GetOptions(out options);
                dlg.SetOptions(options | PickFolders | ForceFileSystem | NoChangeDir | PathMustExist | ForceShowHidden);
                uint back;
                dlg.GetOptions(out back);
                if ((back & (PickFolders | ForceShowHidden)) != (PickFolders | ForceShowHidden)) return "its options didn't stay: " + back.ToString("x");
                dlg.SetTitle("probe");
                var iid = typeof(IShellItem).GUID;
                IShellItem folder;
                SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out folder);
                string path;
                folder.GetDisplayName(SigdnFileSysPath, out path);
                if (!string.Equals(path.TrimEnd('\\'), start.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) return "a folder's path came back as " + path;
                dlg.SetFolder(folder);
                return null;
            }
            catch (Exception ex) { return ex.GetType().Name + ": " + ex.Message; }
            finally { if (dlg != null) Marshal.FinalReleaseComObject(dlg); }
        }

        static string PickOld(IWin32Window owner, string title)
        {
            using (var pick = new FolderBrowserDialog())
            {
                pick.Description = title;
                pick.ShowNewFolderButton = false;
                return pick.ShowDialog(owner) == DialogResult.OK ? pick.SelectedPath : null;
            }
        }
    }
}
