# Signs the input helper (and Beam.exe, which the helper checks) with the builder's own code-signing certificate
# (Windows 1.22, plan rc-admin.md). The first build makes it: RSA 3072, code signing only, 20 years,
# "CN=Beam input helper (self-made)", saved as a .pfx (never committed; one per person who builds, like the update
# key). Windows gives the helper UIAccess only on a PC whose Trusted Root has this certificate: the PC's one-time
# setup puts the public part there (CerOut, embedded in Beam.exe).
#   powershell -NoProfile -ExecutionPolicy Bypass -File helper-sign.ps1 -Pfx <file> -Files "<a.exe>;<b.exe>" -CerOut <file>
param([Parameter(Mandatory = $true)][string]$Pfx, [Parameter(Mandatory = $true)][string]$Files, [string]$CerOut)
$ErrorActionPreference = 'Stop'
$X = 'System.Security.Cryptography.X509Certificates'

if (-not (Test-Path -LiteralPath $Pfx)) {
  $dir = Split-Path -Parent $Pfx
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  $rsa = [System.Security.Cryptography.RSA]::Create(3072)
  $req = New-Object "$X.CertificateRequest" ('CN=Beam input helper (self-made)', $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $eku = New-Object System.Security.Cryptography.OidCollection
  [void]$eku.Add((New-Object System.Security.Cryptography.Oid '1.3.6.1.5.5.7.3.3'))
  $req.CertificateExtensions.Add((New-Object "$X.X509EnhancedKeyUsageExtension" ($eku, $false)))
  $req.CertificateExtensions.Add((New-Object "$X.X509KeyUsageExtension" ([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature, $true)))
  $made = $req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddYears(20))
  [IO.File]::WriteAllBytes($Pfx, $made.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx))
  $made.Reset()
  Write-Host "Made the input helper's signing certificate: $Pfx"
}

# (its key goes into a temporary container, gone after Reset)
$cert = New-Object "$X.X509Certificate2" ($Pfx, '', [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::UserKeySet)
try {
  foreach ($f in ($Files -split ';' | Where-Object { $_ })) {
    $sig = Set-AuthenticodeSignature -LiteralPath $f -Certificate $cert -HashAlgorithm SHA256
    if (-not $sig.SignerCertificate -or $sig.SignerCertificate.Thumbprint -ne $cert.Thumbprint) { throw "Could not sign $f ($($sig.StatusMessage))" }
  }
  if ($CerOut) { [IO.File]::WriteAllBytes($CerOut, $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)) }
} finally { $cert.Reset() }
