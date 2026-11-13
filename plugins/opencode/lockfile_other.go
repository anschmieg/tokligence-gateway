//go:build !linux && !darwin && !freebsd && !netbsd && !openbsd && !dragonfly && !solaris

package opencode

import (
	"fmt"
	"os"
)

// Unsupported platforms fail closed instead of silently dropping ownership.
func lockFileExclusive(file *os.File) error {
	return fmt.Errorf("exclusive session registry locks are unsupported on this platform")
}

func unlockFile(file *os.File) error {
	return nil
}

func syncFile(file *os.File) error {
	return file.Sync()
}

func syncDir(dir string) error { return fmt.Errorf("directory sync unsupported") }
