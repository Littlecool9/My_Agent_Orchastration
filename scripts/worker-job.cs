using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public sealed class WorkerJobResult {
    public string Status = "starting", Error;
    public int LimitMB, ExitCode = 1;
    public uint WorkerPID;
    public ulong PeakBytes;
}

public static class WorkerJob {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct CompletionPort { public IntPtr Key, Port; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint PID, TID; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out ExtendedLimit data, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, UIntPtr key, uint threads);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out UIntPtr key, out IntPtr process, uint timeout);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string executable, StringBuilder commandLine, IntPtr processAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static void Check(bool ok, string operation) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    static void Set<T>(IntPtr job, int kind, T value) {
        IntPtr data = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(T)));
        try { Marshal.StructureToPtr(value, data, false); Check(SetInformationJobObject(job, kind, data, (uint)Marshal.SizeOf(typeof(T))), "SetInformationJobObject"); }
        finally { Marshal.FreeHGlobal(data); }
    }
    static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1).Append(c);
            else result.Append('\\', slashes).Append(c);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static string Json(string text) {
        return text == null ? "null" : "\"" + text.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n").Replace("\t", "\\t") + "\"";
    }
    static void Report(string file, WorkerJobResult result) {
        string text = "{\"status\":" + Json(result.Status) + ",\"limitMB\":" + result.LimitMB + ",\"workerPID\":" + result.WorkerPID
            + ",\"peakBytes\":" + result.PeakBytes + ",\"exitCode\":" + result.ExitCode + ",\"error\":" + Json(result.Error) + "}";
        File.WriteAllText(file, text, new UTF8Encoding(false));
    }
    public static WorkerJobResult Run(string executable, string[] args, int limitMB, string reportFile) {
        var result = new WorkerJobResult { LimitMB = limitMB };
        IntPtr job = IntPtr.Zero, port = IntPtr.Zero;
        ProcessInfo process = new ProcessInfo(); bool assigned = false;
        try {
            if (limitMB < 32) throw new ArgumentException("Memory limit must be at least 32 MiB");
            job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero, "CreateJobObject");
            var limits = new ExtendedLimit();
            // JOB_MEMORY is a hard aggregate commit limit; closing this handle kills descendants.
            limits.Basic.Flags = 0x00000200 | 0x00002000;
            limits.JobMemory = new UIntPtr(checked((ulong)limitMB * 1024 * 1024));
            Set(job, 9, limits);
            port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1); Check(port != IntPtr.Zero, "CreateIoCompletionPort");
            Set(job, 7, new CompletionPort { Key = new IntPtr(1), Port = port });
            var startup = new StartupInfo { Size = (uint)Marshal.SizeOf(typeof(StartupInfo)), Flags = 0x100,
                Input = GetStdHandle(-10), Output = GetStdHandle(-11), Error = GetStdHandle(-12) };
            foreach (IntPtr handle in new[] { startup.Input, startup.Output, startup.Error })
                if (handle != IntPtr.Zero && handle != new IntPtr(-1)) Check(SetHandleInformation(handle, 1, 1), "SetHandleInformation");
            var line = new StringBuilder(Quote(executable)); foreach (string arg in args) line.Append(' ').Append(Quote(arg));
            // Suspend before the first instruction so no compiler/test child can precede job assignment.
            Check(CreateProcess(executable, line, IntPtr.Zero, IntPtr.Zero, true, 0x00000004 | 0x08000000, IntPtr.Zero, null, ref startup, out process), "CreateProcess");
            Check(AssignProcessToJobObject(job, process.Process), "AssignProcessToJobObject"); assigned = true;
            result.WorkerPID = process.PID; result.Status = "running"; Report(reportFile, result);
            Check(ResumeThread(process.Thread) != 0xffffffff, "ResumeThread");
            CloseHandle(process.Thread); process.Thread = IntPtr.Zero;
            for (;;) {
                uint message; UIntPtr key; IntPtr pid;
                bool received = GetQueuedCompletionStatus(port, out message, out key, out pid, 100);
                if (!received && Marshal.GetLastWin32Error() != 258) throw new Win32Exception(Marshal.GetLastWin32Error(), "GetQueuedCompletionStatus");
                ExtendedLimit usage;
                if (QueryInformationJobObject(job, 9, out usage, (uint)Marshal.SizeOf(typeof(ExtendedLimit)), IntPtr.Zero)) result.PeakBytes = usage.PeakJobMemory.ToUInt64();
                if (received && (message == 10 || message == 9)) {
                    result.Status = "memory_limit"; result.ExitCode = 137;
                    result.Error = "Worker process tree reached its " + limitMB + " MiB memory limit";
                    TerminateJobObject(job, 137); break;
                }
                if (WaitForSingleObject(process.Process, 0) == 0) {
                    // A failed allocation may make the root exit before we consume its limit notification.
                    while (GetQueuedCompletionStatus(port, out message, out key, out pid, 0)) {
                        if (message == 10 || message == 9) {
                            result.Status = "memory_limit"; result.ExitCode = 137;
                            result.Error = "Worker process tree reached its " + limitMB + " MiB memory limit";
                            TerminateJobObject(job, 137); break;
                        }
                    }
                    if (result.Status == "memory_limit") break;
                    uint code; Check(GetExitCodeProcess(process.Process, out code), "GetExitCodeProcess");
                    result.ExitCode = unchecked((int)code); result.Status = "exited"; break;
                }
            }
        } catch (Exception error) {
            result.Status = "guard_error"; result.Error = error.Message; result.ExitCode = 1;
        } finally {
            if (!assigned && process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (port != IntPtr.Zero) CloseHandle(port);
            Report(reportFile, result);
        }
        return result;
    }
}
