$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$title = 'Claude Count Usage Installer'
$log = Join-Path $env:LOCALAPPDATA 'ClaudeCountUsage-migration.log'

try {
    $payload = Join-Path $PSScriptRoot 'payload'
    $injector = Join-Path $payload 'desktop-injector.js'
    if (!(Test-Path -LiteralPath $injector)) { throw 'Extract the entire ZIP before opening Install.exe.' }
    $choice = [Windows.Forms.MessageBox]::Show(
        'Set up in-app updates for this installation of Claude Desktop? Claude will close and reopen.',
        $title, 'OKCancel', 'Question'
    )
    if ($choice -ne 'OK') { return }
    $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if (!$node) { throw 'Install Node.js from nodejs.org, then open this installer again.' }

    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $node.Source
    $start.Arguments = '"' + $injector + '" patch "' + (Join-Path $payload 'extension') + '" --launch'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    Set-Content -LiteralPath $log -Value ($stdout.Result + $stderr.Result)
    if ($process.ExitCode -ne 0) { throw "Setup failed. See $log for the reason." }
    [void][Windows.Forms.MessageBox]::Show('Setup is complete. Open Claude Count Usage settings to check for future updates.', $title)
} catch {
    [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, $title, 'OK', 'Error')
}
