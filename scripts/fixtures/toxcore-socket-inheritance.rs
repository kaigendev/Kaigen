#![cfg(windows)]
// Producer gate adapted from the reviewed standalone inheritance experiment.
// Never load profiles, iterate Tox, add peers, bootstrap, or send packets.
use std::{collections::HashSet, ffi::c_void, fs, io::Write, mem, os::windows::{ffi::OsStrExt,
    io::AsRawHandle, process::CommandExt}, path::{Path, PathBuf}, process::{Child, Command, Stdio},
    ptr, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, thread, time::Duration};

type Handle = *mut c_void;
type Result<T> = std::result::Result<T, &'static str>;
const STILL_ACTIVE: u32 = 259;

#[repr(C)] #[derive(Default, Copy, Clone)] struct FileTime { low: u32, high: u32 }
#[repr(C)] #[derive(Default)] struct BasicLimit {
    per_process: i64, per_job: i64, flags: u32, min_working: usize, max_working: usize,
    active_limit: u32, affinity: usize, priority: u32, scheduling: u32,
}
#[repr(C)] #[derive(Default)] struct IoCounters { a: u64, b: u64, c: u64, d: u64, e: u64, f: u64 }
#[repr(C)] #[derive(Default)] struct ExtendedLimit {
    basic: BasicLimit, io: IoCounters, process_memory: usize, job_memory: usize,
    peak_process: usize, peak_job: usize,
}
#[link(name="kernel32")] unsafe extern "system" {
    fn LoadLibraryExW(name: *const u16, file: Handle, flags: u32) -> Handle;
    fn GetProcAddress(module: Handle, name: *const u8) -> *mut c_void;
    fn FreeLibrary(module: Handle) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetCurrentProcess() -> Handle;
    fn GetCurrentProcessId() -> u32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn GetProcessTimes(handle: Handle, creation: *mut FileTime, exit: *mut FileTime,
        kernel: *mut FileTime, user: *mut FileTime) -> i32;
    fn QueryFullProcessImageNameW(handle: Handle, flags: u32, name: *mut u16, size: *mut u32) -> i32;
    fn GetExitCodeProcess(handle: Handle, code: *mut u32) -> i32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, class: i32, information: *const c_void, size: u32) -> i32;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
}
#[link(name="iphlpapi")] unsafe extern "system" {
    fn GetExtendedUdpTable(table: *mut c_void, size: *mut u32, order: i32,
        family: u32, class: i32, reserved: u32) -> u32;
}
#[link(name="bcrypt")] unsafe extern "system" {
    fn BCryptOpenAlgorithmProvider(algorithm: *mut Handle, id: *const u16, implementation: *const u16, flags: u32) -> i32;
    fn BCryptHash(algorithm: Handle, secret: *const u8, secret_size: u32, input: *const u8,
        input_size: u32, output: *mut u8, output_size: u32) -> i32;
    fn BCryptCloseAlgorithmProvider(algorithm: Handle, flags: u32) -> i32;
}
fn require(condition: bool, code: &'static str) -> Result<()> { if condition { Ok(()) } else { Err(code) } }
fn wide(value: &std::ffi::OsStr) -> Vec<u16> { value.encode_wide().chain(Some(0)).collect() }
fn sha256(bytes: &[u8]) -> Result<String> {
    require(bytes.len() <= u32::MAX as usize, "HASH_SIZE")?;
    let name = wide(std::ffi::OsStr::new("SHA256")); let mut provider = ptr::null_mut();
    require(unsafe { BCryptOpenAlgorithmProvider(&mut provider, name.as_ptr(), ptr::null(), 0) } >= 0, "HASH_OPEN")?;
    let mut digest = [0u8; 32];
    let status = unsafe { BCryptHash(provider, ptr::null(), 0, bytes.as_ptr(), bytes.len() as u32, digest.as_mut_ptr(), 32) };
    unsafe { BCryptCloseAlgorithmProvider(provider, 0); }
    require(status >= 0, "HASH_FAILED")?; Ok(digest.iter().map(|x|format!("{x:02x}")).collect())
}
fn canonical(path: &Path) -> Result<PathBuf> { fs::canonicalize(path).map_err(|_|"PATH_CANONICAL") }
fn ordinary(path: &Path) -> Result<()> {
    use std::os::windows::fs::MetadataExt;
    let m = fs::symlink_metadata(path).map_err(|_|"FILE_METADATA")?;
    require(m.is_file() && m.file_attributes() & 0x400 == 0, "FILE_NOT_ORDINARY")
}
fn file_hash(path: &Path) -> Result<String> {
    ordinary(path)?; sha256(&fs::read(path).map_err(|_|"FILE_READ")?)
}
fn pin(path: &Path, expected: &str) -> Result<()> { require(file_hash(path)? == expected, "ARTIFACT_HASH") }
fn process_start(process: Handle) -> Result<u64> {
    let (mut c, mut e, mut k, mut u) = (FileTime::default(), FileTime::default(), FileTime::default(), FileTime::default());
    require(unsafe { GetProcessTimes(process, &mut c, &mut e, &mut k, &mut u) } != 0, "PROCESS_START")?;
    Ok((c.high as u64) << 32 | c.low as u64)
}
fn process_image(process: Handle) -> Result<PathBuf> {
    let mut buffer = vec![0u16; 32768]; let mut size = buffer.len() as u32;
    require(unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size) } != 0, "PROCESS_IMAGE")?;
    use std::os::windows::ffi::OsStringExt;
    canonical(Path::new(&std::ffi::OsString::from_wide(&buffer[..size as usize])))
}
fn alive(process: Handle) -> Result<bool> {
    let mut code = 0; require(unsafe { GetExitCodeProcess(process, &mut code) } != 0, "PROCESS_STATUS")?;
    Ok(code == STILL_ACTIVE)
}

// Endpoint addresses and ports never implement Debug/Display and never enter any report.
#[derive(Clone, Eq, PartialEq, Hash)] struct Endpoint { family: u32, bytes: Vec<u8> }
#[derive(Clone)] struct UdpRow { endpoint: Endpoint, pid: u32 }
fn u32_at(bytes: &[u8], offset: usize) -> Result<u32> {
    let part = bytes.get(offset..offset + 4).ok_or("UDP_ROW_TRUNCATED")?;
    Ok(u32::from_ne_bytes(part.try_into().map_err(|_|"UDP_ROW_TRUNCATED")?))
}
fn decode_udp(bytes: &[u8], family: u32) -> Result<Vec<UdpRow>> {
    let stride = match family { 2 => 12, 23 => 28, _ => return Err("UDP_FAMILY") };
    let count = u32_at(bytes, 0)? as usize;
    require(count <= 131072 && 4usize.checked_add(count * stride).is_some_and(|n|n <= bytes.len()), "UDP_TABLE_SIZE")?;
    let mut rows = Vec::with_capacity(count);
    for index in 0..count { let offset = 4 + index * stride;
        rows.push(UdpRow { endpoint: Endpoint { family, bytes: bytes[offset..offset + stride - 4].to_vec() },
            pid: u32_at(bytes, offset + stride - 4)? });
    } Ok(rows)
}
fn udp_table() -> Result<Vec<UdpRow>> {
    let mut all = Vec::new();
    for family in [2, 23] {
        let mut size = 0u32; let first = unsafe { GetExtendedUdpTable(ptr::null_mut(), &mut size, 0, family, 1, 0) };
        require(first == 122 || first == 0, "UDP_SIZE_QUERY")?;
        let mut decoded = None;
        for _ in 0..4 {
            require((4..=16_777_216).contains(&size), "UDP_ALLOCATION_BOUND")?;
            // u32 backing guarantees the alignment required by both Windows table layouts.
            let mut buffer = vec![0u32; (size as usize + 3) / 4];
            let status = unsafe { GetExtendedUdpTable(buffer.as_mut_ptr().cast(), &mut size, 0, family, 1, 0) };
            if status == 122 { continue; } require(status == 0, "UDP_QUERY_FAILED")?;
            require(size as usize <= buffer.len() * 4, "UDP_RETURN_SIZE")?;
            let bytes = unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast(), size as usize) };
            decoded = Some(decode_udp(bytes, family)?); break;
        }
        all.extend(decoded.ok_or("UDP_TABLE_UNSTABLE")?);
    } Ok(all)
}
fn owned_endpoints(rows: &[UdpRow], pid: u32) -> HashSet<Endpoint> {
    rows.iter().filter(|row|row.pid == pid).map(|row|row.endpoint.clone()).collect()
}
fn same_endpoint_count(rows: &[UdpRow], endpoints: &HashSet<Endpoint>) -> usize {
    rows.iter().filter(|row|endpoints.contains(&row.endpoint)).map(|row|&row.endpoint).collect::<HashSet<_>>().len()
}
fn owned_union(rows: &[UdpRow], parent: u32, child: u32) -> Vec<UdpRow> {
    rows.iter().filter(|row|row.pid == parent || (child != 0 && row.pid == child)).cloned().collect()
}
fn classify(after_tox: usize, after_child: usize) -> &'static str {
    if after_child != 0 { "INCONCLUSIVE_ENDPOINT_REMAINS" }
    else if after_tox != 0 { "INHERITANCE_REPRODUCED" }
    else { "NOT_REPRODUCED" }
}

struct Library(Handle);
impl Drop for Library { fn drop(&mut self) { unsafe { FreeLibrary(self.0); } } }
impl Library {
    fn open(path: &Path) -> Result<Self> {
        let h = unsafe { LoadLibraryExW(wide(path.as_os_str()).as_ptr(), ptr::null_mut(), 0x100 | 0x1000) };
        require(!h.is_null(), "DLL_LOAD")?; Ok(Self(h))
    }
    fn symbol(&self, name: &'static [u8]) -> Result<*mut c_void> {
        let p = unsafe { GetProcAddress(self.0, name.as_ptr()) };
        require(!p.is_null(), "DLL_EXPORT")?; Ok(p)
    }
}
type NewOptions = unsafe extern "C" fn(*mut i32) -> *mut c_void;
type FreeOptions = unsafe extern "C" fn(*mut c_void);
type SetBool = unsafe extern "C" fn(*mut c_void, bool);
type NewTox = unsafe extern "C" fn(*const c_void, *mut i32) -> *mut c_void;
type KillTox = unsafe extern "C" fn(*mut c_void);
struct Options { ptr: *mut c_void, free: FreeOptions }
impl Drop for Options { fn drop(&mut self) { unsafe { (self.free)(self.ptr); } } }
struct Tox { ptr: *mut c_void, kill: KillTox }
impl Tox { fn stop(&mut self) { if !self.ptr.is_null() { unsafe { (self.kill)(self.ptr); } self.ptr = ptr::null_mut(); } } }
impl Drop for Tox { fn drop(&mut self) { self.stop(); } }
fn create_tox(library: &Library) -> Result<Tox> {
    let new_options: NewOptions = unsafe { mem::transmute(library.symbol(b"tox_options_new\0")?) };
    let free: FreeOptions = unsafe { mem::transmute(library.symbol(b"tox_options_free\0")?) };
    let new: NewTox = unsafe { mem::transmute(library.symbol(b"tox_new\0")?) };
    let kill: KillTox = unsafe { mem::transmute(library.symbol(b"tox_kill\0")?) };
    let mut error = -1; let ptr = unsafe { new_options(&mut error) };
    require(!ptr.is_null(), "TOX_OPTIONS_NEW")?; let options = Options {ptr, free};
    require(error == 0, "TOX_OPTIONS_ERROR")?;
    for (name, value) in [(b"tox_options_set_udp_enabled\0".as_slice(), true),
        (b"tox_options_set_ipv6_enabled\0".as_slice(), false),
        (b"tox_options_set_local_discovery_enabled\0".as_slice(), false)] {
        let set: SetBool = unsafe { mem::transmute(library.symbol(name)?) };
        unsafe { set(options.ptr, value); }
    }
    let ptr = unsafe { new(options.ptr, &mut error) };
    require(!ptr.is_null(), "TOX_NEW")?;
    let tox = Tox { ptr, kill }; require(error == 0, "TOX_NEW_ERROR")?; Ok(tox)
}

struct Job(Handle);
impl Drop for Job { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
impl Job {
    fn new() -> Result<Self> {
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        require(!handle.is_null(), "JOB_CREATE")?; let job = Self(handle);
        let mut limits = ExtendedLimit::default(); limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE
        require(unsafe { SetInformationJobObject(job.0, 9, (&limits as *const ExtendedLimit).cast(), mem::size_of_val(&limits) as u32) } != 0, "JOB_LIMITS")?;
        Ok(job)
    }
}
struct OwnedChild { child: Child, start: u64, exe: PathBuf, clean: Arc<AtomicBool> }
impl OwnedChild {
    fn verify(&self) -> Result<()> {
        require(process_start(self.child.as_raw_handle())? == self.start, "CHILD_START")?;
        require(process_image(self.child.as_raw_handle())? == self.exe, "CHILD_IMAGE")?;
        require(alive(self.child.as_raw_handle())?, "CHILD_NOT_ALIVE")
    }
    fn stop(&mut self) -> Result<()> {
        if alive(self.child.as_raw_handle())? {
            self.verify()?; self.child.kill().map_err(|_|"CHILD_KILL")?;
        }
        require(unsafe { WaitForSingleObject(self.child.as_raw_handle(), 3000) } == 0, "CHILD_EXIT_TIMEOUT")?;
        require(!alive(self.child.as_raw_handle())?, "CHILD_STILL_ALIVE")?;
        self.child.try_wait().map_err(|_|"CHILD_REAP")?; self.clean.store(true, Ordering::SeqCst); Ok(())
    }
}
impl Drop for OwnedChild { fn drop(&mut self) {
    if self.stop().is_err() {
        // This retained Child HANDLE came directly from our exact Command::spawn.
        // It cannot refer to a reused PID, even when optional metadata acquisition failed.
        let _ = self.child.kill();
        if unsafe { WaitForSingleObject(self.child.as_raw_handle(), 3000) } == 0 {
            self.clean.store(true, Ordering::SeqCst); let _ = self.child.try_wait();
        }
    }
} }
fn child_main(args: &[String]) -> Result<()> {
    require(args.len() == 4, "CHILD_ARGUMENTS")?;
    let pid = args[2].parse::<u32>().map_err(|_|"CHILD_PARENT_ID")?;
    let start = args[3].parse::<u64>().map_err(|_|"CHILD_PARENT_START")?;
    let parent = unsafe { OpenProcess(0x0010_0000 | 0x1000, 0, pid) };
    require(!parent.is_null(), "CHILD_PARENT_OPEN")?;
    let result = (|| {
        require(process_start(parent)? == start, "CHILD_PARENT_START")?;
        require(process_image(parent)? == canonical(&std::env::current_exe().map_err(|_|"CHILD_SELF")?)?, "CHILD_PARENT_IMAGE")?;
        // No DLL load, network API, observer subprocess or descendant in child.
        unsafe { WaitForSingleObject(parent, 20_000); } Ok(())
    })();
    unsafe { CloseHandle(parent); } result
}

struct Report { file: PathBuf, samples: Vec<String>, parent: u32, parent_start: u64, exe_sha: String,
    child_pid: u32, child_start: u64, clean: Arc<AtomicBool>, artifact_verified: bool,
    artifact: PathBuf, dll_sha: String, pthread_sha: String }
impl Report {
    fn json(&self, status: &str, category: &str) -> String {
        format!(concat!("{{\"schemaVersion\":1,\"kind\":\"kaigen-windows-toxcore-inheritance-producer-gate\",",
            "\"status\":\"{}\",\"classification\":\"{}\",\"watchdogGateClosed\":false,",
            "\"parentPid\":{},\"parentStart100ns\":\"{}\",\"childPid\":{},\"childStart100ns\":\"{}\",",
            "\"probeExeSha256\":\"{}\",\"toxcoreSha256\":\"{}\",\"pthreadSha256\":\"{}\",",
            "\"artifactFilesFreshlyHashed\":{},\"artifactHashesVerified\":{},\"udpEnabled\":true,\"ipv6Enabled\":false,\"localDiscoveryEnabled\":false,",
            "\"toxIterateCalled\":false,\"peersAdded\":false,\"bootstrapCalled\":false,",
            "\"payloadTrafficGeneratedByProbe\":false,\"networkCaptureClaimed\":false,",
            "\"profileDataRead\":false,\"endpointAddressesOrPortsExported\":false,",
            "\"childExitVerified\":{},\"samples\":[{}]}}\n"), status,category,self.parent,self.parent_start,
            self.child_pid,self.child_start,self.exe_sha,self.dll_sha,self.pthread_sha,
            if self.artifact_verified {2}else{0},self.artifact_verified,
            self.clean.load(Ordering::SeqCst),self.samples.join(","))
    }
    fn save(&self, status: &str, category: &str) -> Result<()> {
        let temp = self.file.with_extension("pending");
        let mut f = fs::OpenOptions::new().create_new(true).write(true).open(&temp).map_err(|_|"REPORT_TEMP")?;
        f.write_all(self.json(status,category).as_bytes()).map_err(|_|"REPORT_WRITE")?;
        f.sync_all().map_err(|_|"REPORT_SYNC")?; drop(f);
        fs::rename(&temp,&self.file).map_err(|_|"REPORT_RENAME")
    }
    fn sample(&mut self, phase: &str, rows: &[UdpRow], keys: &HashSet<Endpoint>, child_alive: bool) -> Result<usize> {
        // Windows may attribute an inherited endpoint to either its original creator
        // or the live child. Only this exact owned union may participate in comparison.
        let owned = owned_union(rows,self.parent,self.child_pid);
        let count = same_endpoint_count(&owned,keys);
        self.samples.push(format!("{{\"phase\":\"{}\",\"parentOwnedUdpCount\":{},\"childOwnedUdpCount\":{},\"sameEndpointCount\":{},\"sameEndpointPresent\":{},\"childAlive\":{}}}",
            phase,rows.iter().filter(|r|r.pid==self.parent).count(),rows.iter().filter(|r|r.pid==self.child_pid&&self.child_pid!=0).count(),count,count>0,child_alive));
        self.save("RUNNING","PENDING")?; Ok(count)
    }
}
fn run(report: &mut Report, exe: &Path) -> Result<&'static str> {
    let artifact = &report.artifact;
    pin(&artifact.join("toxcore.dll"),&report.dll_sha)?;
    pin(&artifact.join("pthreadVC3.dll"),&report.pthread_sha)?;
    report.artifact_verified = true;
    let dll = Library::open(&artifact.join("toxcore.dll"))?;
    let baseline = udp_table()?;
    require(owned_endpoints(&baseline, report.parent).is_empty(), "PREEXISTING_PARENT_UDP")?;
    // Control: no child exists. A constructor/kill leak must not be called inheritance.
    let mut control = create_tox(&dll)?;
    let control_before = udp_table()?; let control_keys = owned_endpoints(&control_before, report.parent);
    require(!control_keys.is_empty() && control_keys.iter().all(|key|key.family == 2), "CONTROL_AF_INET_ENDPOINT")?;
    report.sample("control-tox-created-no-child",&control_before,&control_keys,false)?;
    control.stop(); thread::sleep(Duration::from_millis(1000));
    let control_after = report.sample("control-one-second-after-tox-kill",&udp_table()?,&control_keys,false)?;
    require(control_after == 0,"CONTROL_TOX_KILL_ENDPOINT_REMAINS")?;
    let mut tox = create_tox(&dll)?;
    let before = udp_table()?; let keys = owned_endpoints(&before,report.parent);
    require(!keys.is_empty() && keys.iter().all(|key|key.family == 2), "UDP_CONSTRUCTOR_AF_INET_ENDPOINT")?;
    report.sample("tox-created-before-child",&before,&keys,false)?;
    let job = Job::new()?;
    let child_exe = canonical(exe)?;
    let child = Command::new(exe).arg("--child").arg(report.parent.to_string()).arg(report.parent_start.to_string())
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .current_dir(exe.parent().ok_or("SELF_PARENT")?).creation_flags(0x0800_0000).spawn().map_err(|_|"CHILD_SPAWN")?;
    // The Child handle itself is the authority even if metadata acquisition fails.
    let mut child = OwnedChild {child,start:0,exe:child_exe,clean:report.clean.clone()};
    child.start = process_start(child.child.as_raw_handle())?;
    require(unsafe { AssignProcessToJobObject(job.0,child.child.as_raw_handle()) } != 0,"CHILD_JOB_ASSIGN")?;
    child.verify()?; report.child_pid=child.child.id();report.child_start=child.start;
    report.sample("child-alive-before-tox-kill",&udp_table()?,&keys,true)?;
    tox.stop();
    child.verify()?; let immediate = report.sample("immediate-after-tox-kill",&udp_table()?,&keys,true)?;
    thread::sleep(Duration::from_millis(1000)); child.verify()?;
    let after_tox = report.sample("one-second-after-tox-kill",&udp_table()?,&keys,true)?;
    child.stop()?;
    thread::sleep(Duration::from_millis(1000));
    let after_child = report.sample("one-second-after-child-exit",&udp_table()?,&keys,false)?;
    Ok(classify(immediate.max(after_tox),after_child))
}
fn main() {
    std::panic::set_hook(Box::new(|_|{}));
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|s|s=="--child") { if child_main(&args).is_err(){std::process::exit(3)} return; }
    if args.len()!=5 || args[1]!="--run" { eprintln!("ARGUMENTS_DENIED");std::process::exit(2); }
    let prepared = (|| -> Result<(Report,PathBuf)> {
        let exe=std::env::current_exe().map_err(|_|"SELF_EXE")?;
        let base = canonical(exe.parent().ok_or("SELF_PARENT")?)?;
        let artifact = canonical(Path::new(&args[2]))?;
        for hash in [&args[3], &args[4]] { require(hash.len()==64 && hash.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)),"PIN_FORMAT")?; }
        require(exe.file_name().and_then(|x|x.to_str())==Some("socket-inheritance-probe.exe"),"SELF_NAME")?;
        let parent=unsafe{GetCurrentProcessId()}; let parent_start=process_start(unsafe{GetCurrentProcess()})?;
        let file=base.join(format!("inheritance-receipt-{parent}-{parent_start}.json"));
        require(!file.exists(),"RECEIPT_EXISTS")?;
        Ok((Report{file,samples:Vec::new(),parent,parent_start,exe_sha:file_hash(&exe)?,child_pid:0,child_start:0,clean:Arc::new(AtomicBool::new(false)),artifact_verified:false,artifact,dll_sha:args[3].clone(),pthread_sha:args[4].clone()},exe))
    })();
    let (mut report,exe)=match prepared {Ok(x)=>x,Err(code)=>{eprintln!("{code}");std::process::exit(2)}};
    // A process timeout closes all parent handles. Job KILL_ON_JOB_CLOSE and the child's
    // independent 20-second lifetime also bound cleanup if Rust unwinding cannot complete.
    let finished=Arc::new(Mutex::new(false));let flag=finished.clone();let timeout_file=report.file.clone();
    thread::spawn(move|| {thread::sleep(Duration::from_secs(25));if let Ok(done)=flag.lock(){if !*done {
        // Preserve the last complete phase receipt. A separate timeout marker prevents
        // partial observations from being consumed as a completed experiment.
        let _=fs::write(timeout_file.with_extension("timeout.json"),"{\"schemaVersion\":1,\"kind\":\"kaigen-standalone-socket-inheritance-probe\",\"status\":\"TIMEOUT\",\"watchdogGateClosed\":false,\"cleanupNeedsExternalReadback\":true}\n");std::process::exit(4);
    }}});
    let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||run(&mut report,&exe)));
    let (status,category)=match result {Ok(Ok("NOT_REPRODUCED"))=>("PASS","NOT_REPRODUCED"),Ok(Ok(c))=>("FAIL",c),Ok(Err(c))=>("FAIL",c),Err(_)=>("FAIL","PANIC_CLEANUP")};
    let mut done=finished.lock().unwrap_or_else(|e|e.into_inner());
    let saved=report.save(status,category);*done=true;
    println!("{{\"status\":\"{}\",\"classification\":\"{}\",\"watchdogGateClosed\":false}}",if saved.is_ok(){status}else{"FAIL"},if saved.is_ok(){category}else{"REPORT_WRITE"});
    if status!="PASS"||saved.is_err(){std::process::exit(1)}
}

#[cfg(test)] mod tests {
    use super::*;
    fn row(family:u32,pid:u32,seed:u8)->UdpRow{UdpRow{endpoint:Endpoint{family,bytes:vec![seed;if family==2{8}else{24}]},pid}}
    #[test] fn sha_known_vector(){assert_eq!(sha256(b"abc").unwrap(),"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");}
    #[test] fn decode_ipv4_and_ipv6(){for (family,stride) in [(2,12),(23,28)] {let mut bytes=vec![0;4+stride];bytes[..4].copy_from_slice(&1u32.to_ne_bytes());bytes[stride..stride+4].copy_from_slice(&42u32.to_ne_bytes());let rows=decode_udp(&bytes,family).unwrap();assert_eq!(rows.len(),1);assert_eq!(rows[0].pid,42);assert_eq!(rows[0].endpoint.bytes.len(),stride-4);}}
    #[test] fn malformed_tables_fail_closed(){for bytes in [vec![],vec![1,0,0,0],vec![255;4]]{assert!(decode_udp(&bytes,2).is_err());}assert!(decode_udp(&[0;4],99).is_err());}
    #[test] fn ownership_filters_parent_only(){let rows=[row(2,10,1),row(2,11,2),row(23,10,3)];assert_eq!(owned_endpoints(&rows,10).len(),2);assert!(owned_endpoints(&rows,12).is_empty());}
    #[test] fn identity_is_family_and_endpoint_not_pid(){let initial=vec![row(2,10,1)];let keys=owned_endpoints(&initial,10);assert_eq!(same_endpoint_count(&[row(2,11,1)],&keys),1);assert_eq!(same_endpoint_count(&[row(23,11,1)],&keys),0);assert_eq!(same_endpoint_count(&[row(2,11,2)],&keys),0);}
    #[test] fn duplicate_endpoint_rows_do_not_inflate_count(){let keys=owned_endpoints(&[row(2,10,1)],10);assert_eq!(same_endpoint_count(&[row(2,10,1),row(2,11,1)],&keys),1);}
    #[test] fn unrelated_owner_cannot_supply_retention(){let keys=owned_endpoints(&[row(2,10,1)],10);let rows=vec![row(2,99,1),row(2,11,2)];assert_eq!(same_endpoint_count(&owned_union(&rows,10,11),&keys),0);assert_eq!(same_endpoint_count(&owned_union(&[row(2,11,1)],10,11),&keys),1);assert!(owned_union(&[row(2,0,1)],10,0).is_empty());}
    #[test] fn classification_requires_endpoint_disappearance(){assert_eq!(classify(1,0),"INHERITANCE_REPRODUCED");assert_eq!(classify(0,0),"NOT_REPRODUCED");assert_eq!(classify(1,1),"INCONCLUSIVE_ENDPOINT_REMAINS");assert_eq!(classify(0,1),"INCONCLUSIVE_ENDPOINT_REMAINS");}
    #[test] fn public_report_has_no_endpoint_fields(){let r=Report{file:PathBuf::new(),samples:vec![],parent:10,parent_start:20,exe_sha:"a".repeat(64),child_pid:11,child_start:21,clean:Arc::new(AtomicBool::new(true)),artifact_verified:true,artifact:PathBuf::new(),dll_sha:"b".repeat(64),pthread_sha:"c".repeat(64)};let j=r.json("OBSERVED","NOT_REPRODUCED");assert!(!j.contains("localPort")&&!j.contains("localAddress")&&!j.contains("remoteAddress"));assert!(j.contains("\"watchdogGateClosed\":false"));}
}
