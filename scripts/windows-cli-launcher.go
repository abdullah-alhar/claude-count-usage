// A tiny Windows launcher for the adjacent CLI installer.
//
// Build the local-source variant from macOS/Linux:
//   GOOS=windows GOARCH=amd64 go build -o Install-v2.exe \
//     -ldflags "-X main.scriptName=install-v2.bat" scripts/windows-cli-launcher.go
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

var scriptName = "install.bat"

func main() {
	executable, err := os.Executable()
	if err != nil {
		fmt.Println("Could not locate the installer:", err)
		os.Exit(1)
	}

	script := filepath.Join(filepath.Dir(executable), scriptName)
	if _, err := os.Stat(script); err != nil {
		fmt.Printf("Error: Could not locate %s next to this executable.\n", scriptName)
		os.Exit(1)
	}

	command := exec.Command("cmd.exe", "/c", script)
	command.Dir = filepath.Dir(executable)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		fmt.Println("Installer failed:", err)
		os.Exit(1)
	}
}
