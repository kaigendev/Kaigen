using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using FILETIME = System.Runtime.InteropServices.ComTypes.FILETIME;

// Read-only host-prepared observation. No messages that change UI or MSI state.
public static class KaigenMsiRuntimeObserver {
    const uint UserUnmanaged = 2, Success = 0, MoreData = 234, NoMoreItems = 259, UnknownComponent = 1607;
    const uint WM_GETTEXT = 13, WM_GETTEXTLENGTH = 14, BM_GETCHECK = 0xF0, TimeoutFlags = 0x22;
    const int MaximumText = 4096, MaximumComponents = 2048, MaximumClients = 1024;
    delegate bool EnumWindow(IntPtr hwnd, IntPtr unused);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
    [DllImport("user32.dll",SetLastError=true)] static extern bool EnumWindows(EnumWindow callback,IntPtr unused);
    [DllImport("user32.dll",SetLastError=true)] static extern bool EnumChildWindows(IntPtr parent,EnumWindow callback,IntPtr unused);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent,IntPtr child);
    [DllImport("user32.dll",SetLastError=true)] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Unicode,ExactSpelling=true)] static extern int GetClassNameW(IntPtr hwnd,StringBuilder value,int count);
    [DllImport("user32.dll",EntryPoint="GetWindowLongW",SetLastError=true)] static extern int GetWindowLongW(IntPtr hwnd,int index);
    [DllImport("user32.dll",SetLastError=true)] static extern bool GetWindowRect(IntPtr hwnd,out RECT rectangle);
    [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Unicode,ExactSpelling=true)] static extern IntPtr SendMessageTimeoutW(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam,uint flags,uint timeout,out IntPtr result);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out FILETIME created,out FILETIME exited,out FILETIME kernel,out FILETIME user);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool ProcessIdToSessionId(uint pid,out uint session);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode,ExactSpelling=true)] static extern bool QueryFullProcessImageNameW(IntPtr handle,uint flags,StringBuilder image,ref uint size);
    [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint MsiGetProductInfoExW(string productCode,string userSid,uint context,string property,StringBuilder value,ref uint chars);
    [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint MsiEnumRelatedProductsW(string upgradeCode,uint reserved,uint index,StringBuilder productCode);
    [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint MsiEnumClientsExW(string componentCode,string userSid,uint context,uint index,StringBuilder productCode,out uint installedContext,StringBuilder installedSid,ref uint sidChars);
    static void Require(bool value,string message) { if(!value)throw new InvalidOperationException(message); }
    static void Native(bool value,string operation) { if(!value)throw new Win32Exception(Marshal.GetLastWin32Error(),operation); }
    static long FileTime(FILETIME value) { return ((long)(uint)value.dwHighDateTime<<32)|(uint)value.dwLowDateTime; }
    static string GuidCode(string value) { Guid parsed;Require(Guid.TryParseExact(value,"B",out parsed),"Braced MSI GUID required");return parsed.ToString("B").ToUpperInvariant(); }
    static Dictionary<string,object> ProcessIdentity(IntPtr handle,uint pid,long birth,uint session) {
        Require(pid>0 && birth>0 && GetProcessId(handle)==pid,"Held msiexec PID identity mismatch");
        Require(WaitForSingleObject(handle,0)==258,"Held msiexec has exited or cannot be observed");
        FILETIME a,b,c,d;Native(GetProcessTimes(handle,out a,out b,out c,out d),"Observe held msiexec birth");
        Require(FileTime(a)==birth,"Stale msiexec PID/birth");
        uint actualSession;Native(ProcessIdToSessionId(pid,out actualSession),"Observe held msiexec session");
        Require(actualSession==session,"Held msiexec session mismatch");
        var image=new StringBuilder(32768);uint count=(uint)image.Capacity;
        Native(QueryFullProcessImageNameW(handle,0,image,ref count),"Observe held msiexec image");
        string expected=Path.Combine(Environment.SystemDirectory,"msiexec.exe");
        Require(String.Equals(image.ToString(),expected,StringComparison.OrdinalIgnoreCase),"Held target is not exact System32 msiexec");
        return new Dictionary<string,object>{{"pid",pid},{"creationFileTime",birth},{"sessionId",session},{"imagePath",image.ToString()}};
    }
    static IntPtr Message(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam) {
        IntPtr result;Native(SendMessageTimeoutW(hwnd,message,wparam,lparam,TimeoutFlags,1000,out result)!=IntPtr.Zero,"Readonly UI message timeout/failure");return result;
    }
    static string Text(IntPtr hwnd) {
        long chars=Message(hwnd,WM_GETTEXTLENGTH,IntPtr.Zero,IntPtr.Zero).ToInt64();
        Require(chars>=0 && chars<=MaximumText,"UI text exceeds bounded observation");
        IntPtr buffer=Marshal.AllocHGlobal(checked(((int)chars+1)*2));
        try { Marshal.WriteInt16(buffer,0);long copied=Message(hwnd,WM_GETTEXT,new IntPtr(chars+1),buffer).ToInt64();Require(copied>=0 && copied<=chars,"UI text changed beyond observed bound");return Marshal.PtrToStringUni(buffer,(int)copied); }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    static string Class(IntPtr hwnd) { var value=new StringBuilder(256);Native(GetClassNameW(hwnd,value,value.Capacity)>0,"Observe HWND class");return value.ToString(); }
    static Dictionary<string,object> Rect(IntPtr hwnd) {
        RECT value;Native(GetWindowRect(hwnd,out value),"Observe HWND rectangle");
        Require(value.right>value.left && value.bottom>value.top,"UI control rectangle is empty");
        return new Dictionary<string,object>{{"left",value.left},{"top",value.top},{"right",value.right},{"bottom",value.bottom}};
    }
    static void OwnedWindow(IntPtr hwnd,uint pid) { uint actual;Require(IsWindow(hwnd) && GetWindowThreadProcessId(hwnd,out actual)!=0 && actual==pid,"HWND is stale or belongs to another process"); }
    static void Checkbox(string className,uint style) { uint kind=style&15;Require(className=="Button" && (kind==2 || kind==3),"Launch control is not a checkbox"); }
    static void ClientContext(uint context,string actualSid,string expectedSid) { Require(context==UserUnmanaged && actualSid==expectedSid,"Foreign MSI client SID/context returned"); }
    static IntPtr Unique(List<IntPtr> values,string label) { Require(values.Count==1,"Expected one unique "+label+"; observed "+values.Count);return values[0]; }
    static Dictionary<string,object> Control(IntPtr hwnd,uint pid) {
        OwnedWindow(hwnd,pid);
        return new Dictionary<string,object>{{"hwnd",hwnd.ToInt64()},{"className",Class(hwnd)},{"text",Text(hwnd)},{"style",unchecked((uint)GetWindowLongW(hwnd,-16))},{"visible",IsWindowVisible(hwnd)},{"enabled",IsWindowEnabled(hwnd)},{"rect",Rect(hwnd)}};
    }
    public static Dictionary<string,object> InspectFinish(uint pid,long creationFileTime,uint sessionId,string expectedDialogTitle,string launchText,string finishText) {
        Require(pid>0 && creationFileTime>0,"Valid held msiexec identity required");
        Require(!String.IsNullOrEmpty(expectedDialogTitle) && expectedDialogTitle.IndexOf("Kaigen",StringComparison.Ordinal)>=0,"Exact Kaigen dialog title required");
        Require(!String.IsNullOrEmpty(launchText) && !String.IsNullOrEmpty(finishText),"Exact control text required");
        IntPtr process=OpenProcess(0x101000,false,pid);Native(process!=IntPtr.Zero,"Open held readonly msiexec");
        try {
            var before=ProcessIdentity(process,pid,creationFileTime,sessionId);
            var dialogs=new List<IntPtr>();Exception error=null;
            EnumWindow top=delegate(IntPtr hwnd,IntPtr unused) { try { uint owner;GetWindowThreadProcessId(hwnd,out owner);if(owner==pid && IsWindowVisible(hwnd) && IsWindowEnabled(hwnd) && Class(hwnd)=="MsiDialogCloseClass" && Text(hwnd)==expectedDialogTitle)dialogs.Add(hwnd);return true; }catch(Exception ex){error=ex;return false;} };
            Native(EnumWindows(top,IntPtr.Zero),"Enumerate exact Finish dialog");if(error!=null)throw error;
            IntPtr dialog=Unique(dialogs,"visible enabled Kaigen dialog");
            var controls=new List<Dictionary<string,object>>();var checkboxes=new List<IntPtr>();var finishButtons=new List<IntPtr>();
            EnumWindow descendant=delegate(IntPtr hwnd,IntPtr unused) { try {
                OwnedWindow(hwnd,pid);Require(IsChild(dialog,hwnd),"Enumerated HWND is not a dialog descendant");
                // Hidden descendants remain represented without requiring a screen rectangle.
                var row=new Dictionary<string,object>{{"hwnd",hwnd.ToInt64()},{"className",Class(hwnd)},{"text",Text(hwnd)},{"style",unchecked((uint)GetWindowLongW(hwnd,-16))},{"visible",IsWindowVisible(hwnd)},{"enabled",IsWindowEnabled(hwnd)}};
                if(IsWindowVisible(hwnd)){row.Add("rect",Rect(hwnd));}
                controls.Add(row);Require(controls.Count<=2048,"Dialog tree exceeds bounded observation");
                if(IsWindowVisible(hwnd) && IsWindowEnabled(hwnd) && (string)row["className"]=="Button") {
                    if((string)row["text"]==launchText)checkboxes.Add(hwnd);
                    if((string)row["text"]==finishText)finishButtons.Add(hwnd);
                }
                return true;
            }catch(Exception ex){error=ex;return false;} };
            // EnumChildWindows reports zero for empty descendants without a reliable last-error contract.
            EnumChildWindows(dialog,descendant,IntPtr.Zero);if(error!=null)throw error;
            IntPtr checkbox=Unique(checkboxes,"visible enabled Launch checkbox"),finish=Unique(finishButtons,"visible enabled Finish button");
            Checkbox(Class(checkbox),unchecked((uint)GetWindowLongW(checkbox,-16)));
            uint finishType=unchecked((uint)GetWindowLongW(finish,-16))&15;Require(Class(finish)=="Button" && (finishType==0 || finishType==1),"Finish is not a pushbutton");
            long state=Message(checkbox,BM_GETCHECK,IntPtr.Zero,IntPtr.Zero).ToInt64();Require(state==0 || state==1,"Checkbox state is neither unchecked nor checked");
            var dialogRow=Control(dialog,pid);var checkboxRow=Control(checkbox,pid);var finishRow=Control(finish,pid);
            Require(IsChild(dialog,checkbox) && IsChild(dialog,finish) && IsWindowVisible(dialog) && IsWindowEnabled(dialog) && (string)dialogRow["className"]=="MsiDialogCloseClass" && (string)dialogRow["text"]==expectedDialogTitle,"Finish dialog/descendant gate changed");
            Require((bool)checkboxRow["visible"] && (bool)checkboxRow["enabled"] && (string)checkboxRow["text"]==launchText && (bool)finishRow["visible"] && (bool)finishRow["enabled"] && (string)finishRow["text"]==finishText,"Finish controls changed during observation");
            Checkbox((string)checkboxRow["className"],(uint)checkboxRow["style"]);
            finishType=(uint)finishRow["style"]&15;Require((string)finishRow["className"]=="Button" && (finishType==0 || finishType==1),"Finish button type changed during observation");
            OwnedWindow(checkbox,pid);OwnedWindow(finish,pid);
            Require(Message(checkbox,BM_GETCHECK,IntPtr.Zero,IntPtr.Zero).ToInt64()==state,"Checkbox changed during observation");
            var after=ProcessIdentity(process,pid,creationFileTime,sessionId);
            return new Dictionary<string,object>{{"schema",1},{"status","READONLY_NATIVE_FINISH_OBSERVED"},{"utc",DateTime.UtcNow.ToString("o")},{"processBefore",before},{"processAfter",after},{"dialogHwnd",dialog.ToInt64()},{"checkboxHwnd",checkbox.ToInt64()},{"finishHwnd",finish.ToInt64()},{"checkboxState",state},{"dialog",dialogRow},{"checkbox",checkboxRow},{"finish",finishRow},{"controls",controls},{"uiMutated",false}};
        }finally { CloseHandle(process); }
    }
    static int DecodeScopedState(uint status,string value) {
        if(status==1605)return -1;
        if(status!=Success)throw new Win32Exception((int)status,"MsiGetProductInfoExW(State)");
        if(value=="1")return 1;
        if(value=="5")return 5;
        throw new InvalidOperationException("Unexpected current-user unmanaged MSI State");
    }
    public static int QueryProductState(string productCode) {
        string code=GuidCode(productCode),sid;
        using(var identity=WindowsIdentity.GetCurrent()){Require(identity.User!=null,"Current token SID required");sid=identity.User.Value;}
        var value=new StringBuilder(16);uint chars=(uint)value.Capacity;
        uint status=MsiGetProductInfoExW(code,sid,UserUnmanaged,"State",value,ref chars);
        return DecodeScopedState(status,value.ToString());
    }
    public static string[] EnumRelatedProducts(string upgradeCode) {
        string code=GuidCode(upgradeCode);var products=new SortedSet<string>(StringComparer.Ordinal);var seen=new HashSet<string>(StringComparer.Ordinal);
        for(uint i=0;i<MaximumClients;i++) { var value=new StringBuilder(39);uint status=MsiEnumRelatedProductsW(code,0,i,value);if(status==NoMoreItems)return new List<string>(products).ToArray();if(status!=Success)throw new Win32Exception((int)status,"MsiEnumRelatedProductsW");string product=GuidCode(value.ToString());Require(seen.Add(product),"Duplicate related MSI product");if(QueryProductState(product)!=-1)Require(products.Add(product),"Duplicate scoped MSI product"); }
        throw new InvalidOperationException("Related product enumeration exceeds bound");
    }
    public static Dictionary<string,object> EnumComponentClients(string[] componentCodes,string userSid) {
        Require(componentCodes!=null && componentCodes.Length>0 && componentCodes.Length<=MaximumComponents,"Bounded nonempty Component table GUID array required");
        Require(!String.IsNullOrEmpty(userSid) && new SecurityIdentifier(userSid).Value==userSid,"Canonical selected user SID required");
        using(var identity=WindowsIdentity.GetCurrent()){Require(identity.User!=null && identity.User.Value==userSid,"Selected MSI client SID must match current token");}
        var result=new Dictionary<string,object>(StringComparer.Ordinal);var components=new SortedSet<string>(StringComparer.Ordinal);
        foreach(string code in componentCodes)Require(components.Add(GuidCode(code)),"Duplicate Component table GUID");
        foreach(string component in components) {
            var rows=new SortedDictionary<string,Dictionary<string,object>>(StringComparer.Ordinal);bool ended=false;
            for(uint i=0;i<MaximumClients;i++) {
                var product=new StringBuilder(39);var sid=new StringBuilder(256);uint chars=(uint)sid.Capacity,context;
                uint status=MsiEnumClientsExW(component,null,UserUnmanaged,i,product,out context,sid,ref chars);
                if(status==MoreData) { Require(chars>0 && chars<=4096,"MSI client SID exceeds bound");sid=new StringBuilder(checked((int)chars+1));chars=(uint)sid.Capacity;status=MsiEnumClientsExW(component,null,UserUnmanaged,i,product,out context,sid,ref chars); }
                if(status==NoMoreItems || (status==UnknownComponent && i==0)){ended=true;break;}
                if(status!=Success)throw new Win32Exception((int)status,"MsiEnumClientsExW");
                ClientContext(context,sid.ToString(),userSid);
                string productCode=GuidCode(product.ToString());Require(!rows.ContainsKey(productCode),"Duplicate MSI component client");
                rows.Add(productCode,new Dictionary<string,object>{{"productCode",productCode},{"userSid",userSid},{"context",context}});
            }
            Require(ended,"MSI client enumeration exceeds bound");result.Add(component,new List<Dictionary<string,object>>(rows.Values).ToArray());
        }
        return result;
    }
}
