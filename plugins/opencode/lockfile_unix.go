//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly || solaris

package opencode

import (
	"os"
	"syscall"
)

// lockFileExclusive takes an advisory exclusive lock on the file (flock
// LOCK_EX|LOCK_NB): the registry's single-owner guarantee. Unlocking closes
// out ownership; the lock dies with the process on crash, which is exactly
// the crash-recovery behavior a state lock wants.
func lockFileExclusive(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}

func unlockFile(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
}

func syncFile(file *os.File) error {
	return file.Sync()
}

// syncDir fsyncs the directory so a rename is durable. Best effort: some
// filesystems refuse directory fsync.
func syncDir(dir string) {
	handle, err := os.Open(dir)
	if err != nil {
		return
	}
	defer handle.Close()
	_ = handle.Sync()
}
