//go:build !linux && !darwin && !freebsd && !netbsd && !openbsd && !dragonfly && !solaris

package opencode

import "os"

// Non-Unix fallback: no flock. Single ownership degrades to lockfile-exists
// semantics (O_EXCL create). The plugin targets linux/darwin hosts; this
// keeps the build green elsewhere with honest weaker semantics.
func lockFileExclusive(file *os.File) error {
	return nil
}

func unlockFile(file *os.File) error {
	return nil
}

func syncFile(file *os.File) error {
	return file.Sync()
}

func syncDir(dir string) {}
