$lnk = 'C:\Users\lucel\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Deva.lnk'
if (Test-Path $lnk) {
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  Write-Output ('TARGET=' + $s.TargetPath)
  Write-Output ('ARGS=' + $s.Arguments)
} else {
  Write-Output 'NO_SHORTCUT'
}