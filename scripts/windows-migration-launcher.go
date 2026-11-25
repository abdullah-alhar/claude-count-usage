//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

func main() {
	executable, err := os.Executable()
	if err == nil {
		powershell := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
		script := filepath.Join(filepath.Dir(executable), "migration.ps1")
		command := exec.Command(powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script)
		command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
		err = command.Run()
	}
	if err != nil {
		title, _ := syscall.UTF16PtrFromString("Claude Count Usage Installer")
		message, _ := syscall.UTF16PtrFromString("Could not open the installer. Extract the ZIP before opening Install.exe.\n\n" + err.Error())
		syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
	}
}
