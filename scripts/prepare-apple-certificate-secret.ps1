param(
  [Parameter(Mandatory = $true)]
  [string]$P12Path,

  [switch]$CopyToClipboard
)

$resolvedPath = Resolve-Path -Path $P12Path -ErrorAction Stop
$bytes = [System.IO.File]::ReadAllBytes($resolvedPath)
$encoded = [System.Convert]::ToBase64String($bytes)

if ($CopyToClipboard) {
  Set-Clipboard -Value $encoded
}

Write-Output $encoded
