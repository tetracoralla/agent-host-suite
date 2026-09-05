# The guardian owns the only Job handle. Closing it kills every Provider
# descendant, including when the Provider root exits before Host cancellation.
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
try {
  $launch = ConvertFrom-Json -InputObject $env:OPENADAM_PROVIDER_LAUNCH
  [Environment]::SetEnvironmentVariable('OPENADAM_PROVIDER_LAUNCH', $null, 'Process')
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class OpenAdamProviderJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr Minimum, Maximum;
    public uint ActiveLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel;
    public uint Faults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int Size; public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread; public uint ProcessId, ThreadId;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits data, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting data, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Require(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') result.Append('\\', slashes * 2 + 1);
      else result.Append('\\', slashes);
      result.Append(c); slashes = 0;
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }
  public static int Run(string command, string[] args, string cwd) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    ProcessInfo process = new ProcessInfo();
    try {
      var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
      Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      var startup = new Startup(); startup.Size = Marshal.SizeOf(typeof(Startup)); startup.Flags = 0x100;
      startup.Input = GetStdHandle(-10); startup.Output = GetStdHandle(-11); startup.Error = GetStdHandle(-12);
      foreach (IntPtr handle in new [] { startup.Input, startup.Output, startup.Error }) Require(SetHandleInformation(handle, 1, 1));
      var line = new StringBuilder(Quote(command));
      foreach (string arg in args) line.Append(' ').Append(Quote(arg));
      Require(CreateProcess(command, line, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, cwd, ref startup, out process));
      // The root is suspended until admission, so no descendant can escape the Job.
      Require(AssignProcessToJobObject(job, process.Process));
      if (ResumeThread(process.Thread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (WaitForSingleObject(process.Process, 0xffffffff) != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint code; Require(GetExitCodeProcess(process.Process, out code));
      Require(TerminateJobObject(job, code));
      for (int attempt = 0; attempt < 500; attempt++) {
        Accounting status;
        Require(QueryInformationJobObject(job, 1, out status, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        if (status.Active == 0) return unchecked((int)code);
        Thread.Sleep(10);
      }
      throw new Exception("Provider Job did not terminate");
    } finally {
      if (process.Process != IntPtr.Zero) { TerminateProcess(process.Process, 125); CloseHandle(process.Process); }
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      CloseHandle(job);
    }
  }
}
'@
  $status = [OpenAdamProviderJob]::Run([string]$launch.command, [string[]]@($launch.args), [string]$launch.cwd)
  exit $status
} catch {
  $cause = $_.Exception.GetBaseException()
  $code = if ($cause -is [System.ComponentModel.Win32Exception]) { $cause.NativeErrorCode } else { $_.FullyQualifiedErrorId -replace '[^A-Za-z0-9_.-]', '' }
  [Console]::Error.WriteLine("Agent Host Windows Provider Job failed ($code).")
  exit 125
}
