"""Serialize expensive local TTS/render commands across video task windows."""
from pathlib import Path
import argparse
import ctypes
from ctypes import wintypes
import json
import msvcrt
import os
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / 'data/local-resource.lock'


def bind_child_lifetime():
    """Put this guard in a kill-on-close job before it can create any children.

    Keep the sole job handle open until process exit. If this guard is killed,
    Windows also terminates its descendants before another workload proceeds.
    """
    class BasicLimits(ctypes.Structure):
        _fields_ = [('process_time',ctypes.c_int64),('job_time',ctypes.c_int64),
                    ('flags',wintypes.DWORD),('min_ws',ctypes.c_size_t),('max_ws',ctypes.c_size_t),
                    ('active_limit',wintypes.DWORD),('affinity',ctypes.c_size_t),
                    ('priority',wintypes.DWORD),('scheduling',wintypes.DWORD)]
    class IoCounters(ctypes.Structure):
        _fields_ = [(name,ctypes.c_uint64) for name in ['read_ops','write_ops','other_ops','read_bytes','write_bytes','other_bytes']]
    class ExtendedLimits(ctypes.Structure):
        _fields_ = [('basic',BasicLimits),('io',IoCounters),('process_mem',ctypes.c_size_t),
                    ('job_mem',ctypes.c_size_t),('peak_process',ctypes.c_size_t),('peak_job',ctypes.c_size_t)]
    kernel = ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p,wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE,wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    job = kernel.CreateJobObjectW(None,None)
    if not job:raise ctypes.WinError(ctypes.get_last_error())
    limits = ExtendedLimits()
    limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel.SetInformationJobObject(job,9,ctypes.byref(limits),ctypes.sizeof(limits)):
        error=ctypes.get_last_error();kernel.CloseHandle(job);raise ctypes.WinError(error)
    if not kernel.AssignProcessToJobObject(job,kernel.GetCurrentProcess()):
        error=ctypes.get_last_error();kernel.CloseHandle(job);raise ctypes.WinError(error)
    # This raw handle is deliberately not closed in-process: closing it would
    # terminate the guard itself. The OS closes it when this process exits.
    return job


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--owner',required=True)
    p.add_argument('--timeout',type=float,default=900)
    p.add_argument('command',nargs=argparse.REMAINDER)
    args = p.parse_args()
    command = args.command[1:] if args.command[:1]==['--'] else args.command
    if not command:
        p.error('A command is required after --.')
    if args.timeout < 0:
        p.error('timeout must be non-negative')
    job_handle = bind_child_lifetime()
    LOCK.parent.mkdir(parents=True,exist_ok=True)
    with LOCK.open('a+b') as lock:
        if os.fstat(lock.fileno()).st_size == 0:
            lock.write(b'0'); lock.flush()
        started = time.monotonic()
        announced = False
        while True:
            lock.seek(0)
            try:
                msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
                break
            except OSError:
                if not announced:
                    print(json.dumps({'owner':args.owner,'state':'waiting_for_local_compute'},ensure_ascii=False),flush=True)
                    announced = True
                if time.monotonic()-started >= args.timeout:
                    print('Local compute remains occupied. Resume this same task later.',flush=True)
                    return 2
                time.sleep(0.25)
        try:
            print(json.dumps({'owner':args.owner,'state':'running','wait_seconds':round(time.monotonic()-started,3)},ensure_ascii=False),flush=True)
            return subprocess.run(command,creationflags=subprocess.CREATE_NO_WINDOW).returncode
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(),msvcrt.LK_UNLCK,1)


if __name__ == '__main__':
    sys.exit(main())
