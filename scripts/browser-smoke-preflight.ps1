[CmdletBinding()]
param(
    [string]$Executable = "src-tauri/target/release/long-translate.exe",
    [string]$ExtensionDirectory = "browser-extension/dist",
    [switch]$RegisterNativeHost,
    [switch]$RequireDesktop
)

$ErrorActionPreference = "Stop"
$hostName = "com.long.translate"
$expectedExtensionId = "imaogjlfhfohdnngppnfhapdfkaldmkn"
$expectedOrigin = "chrome-extension://$expectedExtensionId/"
$maximumExtensionBytes = 64 * 1024

function Assert-Preflight {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw "Browser smoke preflight failed: $Message"
    }
}

function Resolve-RequiredPath {
    param([string]$Path, [string]$Label)
    Assert-Preflight (Test-Path -LiteralPath $Path) "$Label was not found at $Path"
    return (Resolve-Path -LiteralPath $Path).Path
}

function Get-ExtensionId {
    param([string]$PublicKey)
    Assert-Preflight (-not [string]::IsNullOrWhiteSpace($PublicKey)) "extension public key is missing"
    try {
        $keyBytes = [Convert]::FromBase64String($PublicKey)
    } catch {
        throw "Browser smoke preflight failed: extension public key is not valid Base64"
    }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $hasher.ComputeHash($keyBytes)
    } finally {
        $hasher.Dispose()
    }
    $characters = foreach ($byte in $hash[0..15]) {
        [char]([int][char]'a' + ($byte -shr 4))
        [char]([int][char]'a' + ($byte -band 0x0f))
    }
    return -join $characters
}

function Find-Browser {
    param([string[]]$Candidates, [string]$Label)
    $path = $Candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    Assert-Preflight (-not [string]::IsNullOrWhiteSpace($path)) "$Label is not installed in a supported location"
    return (Resolve-Path -LiteralPath $path).Path
}

$resolvedExecutable = Resolve-RequiredPath $Executable "desktop executable"
$resolvedExtension = Resolve-RequiredPath $ExtensionDirectory "built browser extension"
$sourceManifestPath = Resolve-RequiredPath "browser-extension/public/manifest.json" "reviewed extension manifest"
$builtManifestPath = Resolve-RequiredPath (Join-Path $resolvedExtension "manifest.json") "built extension manifest"

$sourceManifestText = Get-Content -Raw -Encoding UTF8 -LiteralPath $sourceManifestPath
$builtManifestText = Get-Content -Raw -Encoding UTF8 -LiteralPath $builtManifestPath
$sourceManifest = $sourceManifestText | ConvertFrom-Json
$builtManifest = $builtManifestText | ConvertFrom-Json

Assert-Preflight ($sourceManifest.manifest_version -eq 3) "extension is not Manifest V3"
Assert-Preflight (($sourceManifest.permissions -join ",") -eq "nativeMessaging,activeTab,scripting") "extension permissions exceed the reviewed boundary"
Assert-Preflight ($null -eq $sourceManifest.host_permissions) "extension declares persistent host permissions"
Assert-Preflight ($null -eq $sourceManifest.content_scripts) "extension declares an always-on content script"
Assert-Preflight (($sourceManifest | ConvertTo-Json -Depth 20 -Compress) -eq ($builtManifest | ConvertTo-Json -Depth 20 -Compress)) "built manifest differs from the reviewed source"

$extensionId = Get-ExtensionId $sourceManifest.key
Assert-Preflight ($extensionId -eq $expectedExtensionId) "extension ID is $extensionId instead of $expectedExtensionId"

$requiredExtensionFiles = @(
    "assets/service-worker.js",
    "assets/content-script.js",
    "popup.html",
    "_locales/en/messages.json",
    "_locales/zh_CN/messages.json"
)
foreach ($relativePath in $requiredExtensionFiles) {
    Assert-Preflight (Test-Path -LiteralPath (Join-Path $resolvedExtension $relativePath)) "built extension is missing $relativePath"
}
$extensionBytes = (Get-ChildItem -LiteralPath $resolvedExtension -File -Recurse | Measure-Object -Property Length -Sum).Sum
Assert-Preflight ($extensionBytes -le $maximumExtensionBytes) "extension package exceeds 64 KiB"

$chromePath = Find-Browser @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) "Google Chrome"
$edgePath = Find-Browser @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
) "Microsoft Edge"

if ($RegisterNativeHost) {
    & $resolvedExecutable --register-native-host --origin $expectedOrigin
    if ($null -ne $LASTEXITCODE) {
        Assert-Preflight ($LASTEXITCODE -eq 0) "Native Host registration returned exit code $LASTEXITCODE"
    }
}

$registryKeys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
)
$registeredManifestPaths = foreach ($registryKey in $registryKeys) {
    Assert-Preflight (Test-Path -LiteralPath $registryKey) "registry key is missing: $registryKey"
    $value = (Get-Item -LiteralPath $registryKey).GetValue("")
    Assert-Preflight (-not [string]::IsNullOrWhiteSpace($value)) "registry key has no manifest path: $registryKey"
    Resolve-RequiredPath $value "Native Host manifest"
}
Assert-Preflight (($registeredManifestPaths | Select-Object -Unique).Count -eq 1) "Chrome and Edge point to different Native Host manifests"

$nativeManifestPath = $registeredManifestPaths[0]
$nativeManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $nativeManifestPath | ConvertFrom-Json
Assert-Preflight ($nativeManifest.name -eq $hostName) "Native Host name is invalid"
Assert-Preflight ($nativeManifest.type -eq "stdio") "Native Host transport is not stdio"
Assert-Preflight ((Resolve-Path -LiteralPath $nativeManifest.path).Path -eq $resolvedExecutable) "Native Host manifest points to a different executable"
Assert-Preflight (($nativeManifest.allowed_origins -join ",") -eq $expectedOrigin) "Native Host origin allowlist differs from the reviewed extension"

$desktopReady = $false
if ($env:APPDATA) {
    $endpointPath = Join-Path $env:APPDATA "com.long.translate/browser-ipc.json"
    if (Test-Path -LiteralPath $endpointPath) {
        $endpoint = Get-Content -Raw -Encoding UTF8 -LiteralPath $endpointPath | ConvertFrom-Json
        $parsedToken = [Guid]::Empty
        $tokenValid = [Guid]::TryParse([string]$endpoint.token, [ref]$parsedToken)
        $desktopReady = $endpoint.protocol_version -eq 1 -and
            [string]$endpoint.pipe_name -match '^\\\\\.\\pipe\\com\.long\.translate\.browser\.[0-9a-fA-F-]{36}$' -and
            $tokenValid
    }
}
if ($RequireDesktop) {
    Assert-Preflight $desktopReady "authenticated desktop IPC endpoint is unavailable or invalid"
}

[pscustomobject]@{
    status = "pass"
    chrome = $chromePath
    edge = $edgePath
    extension_id = $extensionId
    extension_bytes = [int64]$extensionBytes
    native_host_manifest = $nativeManifestPath
    native_host_executable = $resolvedExecutable
    desktop_ipc_ready = $desktopReady
    interactive_smoke_required = $true
} | ConvertTo-Json
