[CmdletBinding(DefaultParameterSetName = "Run")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Run")]
    [string]$InputDirectory,

    [Parameter(Mandatory = $true, ParameterSetName = "Run")]
    [string]$OutputDirectory,

    [Parameter(Mandatory = $true, ParameterSetName = "Probe")]
    [switch]$ProbeOnly,

    [Parameter(Mandatory = $true, ParameterSetName = "SelfTest")]
    [switch]$SelfTest
)

$ErrorActionPreference = "Stop"
# Node-based npm runners can pass PowerShell 7 module paths into Windows
# PowerShell 5.1. Load required built-in modules from this host's own
# installation so hashing and signature checks cannot bind to incompatible
# inherited modules.
$requiredModuleNames = @("Microsoft.PowerShell.Security", "Microsoft.PowerShell.Utility")
foreach ($moduleName in $requiredModuleNames) {
    $modulePath = Join-Path $PSHOME "Modules\$moduleName\$moduleName.psd1"
    Import-Module -Name $modulePath -ErrorAction Stop
}
$wordPdfFormat = 17
$wordStatisticPages = 2

function Test-WordIdentityEvidence {
    param([Parameter(Mandatory = $true)]$Evidence)

    $errors = [Collections.Generic.List[string]]::new()
    if ($Evidence.Name -ne "Microsoft Word") {
        $errors.Add("COM application name is not Microsoft Word")
    }

    $majorVersion = 0
    if (-not [int]::TryParse(([string]$Evidence.Version -split '\.')[0], [ref]$majorVersion) -or $majorVersion -lt 16) {
        $errors.Add("Word major version must be 16 or newer")
    }
    if ([string]$Evidence.ApplicationPath -match "(?i)(kingsoft|wps office)") {
        $errors.Add("Word COM application path belongs to WPS or Kingsoft")
    }
    if (-not $Evidence.ExecutableExists) {
        $errors.Add("WINWORD.EXE does not exist under the COM application path")
    }
    if ([string]$Evidence.CompanyName -notmatch "(?i)^Microsoft Corporation$") {
        $errors.Add("WINWORD.EXE company is not Microsoft Corporation")
    }
    if ([string]$Evidence.OriginalFilename -notmatch "(?i)^WINWORD\.EXE$") {
        $errors.Add("Word executable original filename is not WINWORD.EXE")
    }
    if ([string]$Evidence.SignatureStatus -ne "Valid") {
        $errors.Add("WINWORD.EXE Authenticode signature is not valid")
    }
    if ([string]$Evidence.SignerSubject -notmatch "(?i)Microsoft Corporation") {
        $errors.Add("WINWORD.EXE signer is not Microsoft Corporation")
    }
    return $errors.ToArray()
}

function Test-CorpusNames {
    param([Parameter(Mandatory = $true)][string[]]$Names)

    $errors = [Collections.Generic.List[string]]::new()
    $modesByStem = @{}
    foreach ($name in $Names) {
        if ($name -notmatch "^(?<stem>.+)-(?<mode>translated|bilingual)\.docx$") {
            $errors.Add("Unexpected DOCX output name: $name")
            continue
        }
        if (-not $modesByStem.ContainsKey($Matches.stem)) {
            $modesByStem[$Matches.stem] = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        }
        [void]$modesByStem[$Matches.stem].Add($Matches.mode)
    }
    if ($modesByStem.Count -lt 5) {
        $errors.Add("At least five document stems are required")
    }
    foreach ($stem in $modesByStem.Keys) {
        if (-not $modesByStem[$stem].SetEquals([string[]]@("translated", "bilingual"))) {
            $errors.Add("Document stem is missing a translated or bilingual output: $stem")
        }
    }
    return $errors.ToArray()
}

function Resolve-OutputDirectoryPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([IO.Path]::IsPathRooted($Path)) {
        return [IO.Path]::GetFullPath($Path)
    }
    return [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Path))
}

function Test-WordActivationEvidence {
    param(
        [string]$VNextOutput = "",
        [string]$OsppOutput = ""
    )

    return (
        $VNextOutput -match '(?i)"LicenseState"\s*:\s*"Licensed"' -or
        $OsppOutput -match '(?i)LICENSE STATUS:\s*---LICENSED---'
    )
}

function Assert-WordActivated {
    param([Parameter(Mandatory = $true)][string]$ApplicationPath)

    $vNextOutput = ""
    $osppOutput = ""
    $vNextDiag = Join-Path $ApplicationPath "vNextDiag.ps1"
    if (Test-Path -LiteralPath $vNextDiag -PathType Leaf) {
        $vNextOutput = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vNextDiag -action list 2>&1 | Out-String)
    }
    $ospp = Join-Path $ApplicationPath "OSPP.VBS"
    if (Test-Path -LiteralPath $ospp -PathType Leaf) {
        $osppOutput = (& cscript.exe //Nologo $ospp /dstatus 2>&1 | Out-String)
    }
    if (-not (Test-WordActivationEvidence -VNextOutput $vNextOutput -OsppOutput $osppOutput)) {
        throw "Microsoft Word is not activated; sign in with a licensed Office account before running document acceptance"
    }
}

function Get-WordIdentityEvidence {
    param([Parameter(Mandatory = $true)]$Application)

    $applicationPath = [string]$Application.Path
    $executablePath = Join-Path $applicationPath "WINWORD.EXE"
    $exists = Test-Path -LiteralPath $executablePath -PathType Leaf
    $companyName = ""
    $originalFilename = ""
    $signatureStatus = "Missing"
    $signerSubject = ""
    if ($exists) {
        $item = Get-Item -LiteralPath $executablePath
        $companyName = [string]$item.VersionInfo.CompanyName
        $originalFilename = [string]$item.VersionInfo.OriginalFilename
        $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $executablePath
        $signatureStatus = [string]$signature.Status
        if ($null -ne $signature.SignerCertificate) {
            $signerSubject = [string]$signature.SignerCertificate.Subject
        }
    }
    return [PSCustomObject]@{
        Name = [string]$Application.Name
        Version = [string]$Application.Version
        ApplicationPath = $applicationPath
        ExecutablePath = $executablePath
        ExecutableExists = $exists
        CompanyName = $companyName
        OriginalFilename = $originalFilename
        SignatureStatus = $signatureStatus
        SignerSubject = $signerSubject
    }
}

function Close-ComObject {
    param($Value)
    if ($null -ne $Value) {
        try {
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Value)
        } catch {
            # The Office process may already have closed its COM server.
        }
    }
}

function Close-WordApplication {
    param(
        $Application,
        [uint32]$WordProcessId = 0
    )

    if ($null -ne $Application) {
        try { $Application.Quit(0) } catch {}
        Close-ComObject $Application
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    if ($WordProcessId -eq 0) {
        return
    }
    try {
        $process = [Diagnostics.Process]::GetProcessById($WordProcessId)
        if (-not $process.WaitForExit(2000)) {
            $process.Refresh()
            if ($process.MainWindowHandle -eq [IntPtr]::Zero) {
                $process.Kill()
                [void]$process.WaitForExit(5000)
            }
        }
    } catch [ArgumentException] {
        # The isolated Word process already exited after COM release.
    }
}

function Open-VerifiedWord {
    $wordPidsBefore = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
    $application = New-Object -ComObject Word.Application
    [uint32]$wordProcessId = 0
    try {
        $newWordPids = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | Where-Object { $wordPidsBefore -notcontains [uint32]$_.Id })
        if ($newWordPids.Count -eq 1) {
            $wordProcessId = [uint32]$newWordPids[0].Id
        }
        $evidence = Get-WordIdentityEvidence -Application $application
        $identityErrors = Test-WordIdentityEvidence -Evidence $evidence
        if ($identityErrors.Count -gt 0) {
            throw "Microsoft Word identity verification failed: $($identityErrors -join '; ')"
        }
        $application.Visible = $false
        $application.DisplayAlerts = 0
        $application.AutomationSecurity = 3
        $application.Options.UpdateLinksAtOpen = $false
        $application.Options.UpdateFieldsAtPrint = $false
        $application.Options.SaveNormalPrompt = $false
        return [PSCustomObject]@{ Application = $application; Evidence = $evidence; ProcessId = $wordProcessId }
    } catch {
        Close-WordApplication -Application $application -WordProcessId $wordProcessId
        throw
    }
}

function Invoke-SelfTest {
    $valid = [PSCustomObject]@{
        Name = "Microsoft Word"
        Version = "16.0"
        ApplicationPath = "C:\Program Files\Microsoft Office\root\Office16"
        ExecutableExists = $true
        CompanyName = "Microsoft Corporation"
        OriginalFilename = "WINWORD.EXE"
        SignatureStatus = "Valid"
        SignerSubject = "CN=Microsoft Corporation, O=Microsoft Corporation"
    }
    if ((Test-WordIdentityEvidence $valid).Count -ne 0) {
        throw "Self-test rejected valid Microsoft Word identity evidence"
    }

    $wps = $valid.PSObject.Copy()
    $wps.Version = "12.0"
    $wps.ApplicationPath = "C:\Users\test\Kingsoft\WPS Office\office6"
    $wps.ExecutableExists = $false
    $wps.CompanyName = "Kingsoft Corp."
    $wps.SignatureStatus = "NotSigned"
    $wps.SignerSubject = ""
    if ((Test-WordIdentityEvidence $wps).Count -lt 4) {
        throw "Self-test did not reject WPS identity evidence"
    }

    $validCorpus = 1..5 | ForEach-Object { "case-$_-translated.docx"; "case-$_-bilingual.docx" }
    if ((Test-CorpusNames $validCorpus).Count -ne 0) {
        throw "Self-test rejected a valid five-document corpus"
    }
    $invalidCorpus = @("case-1-translated.docx", "unexpected.docx")
    if ((Test-CorpusNames $invalidCorpus).Count -lt 2) {
        throw "Self-test did not reject an incomplete corpus"
    }
    $absoluteOutput = Join-Path ([IO.Path]::GetTempPath()) "word-acceptance-self-test"
    if ((Resolve-OutputDirectoryPath $absoluteOutput) -ne [IO.Path]::GetFullPath($absoluteOutput)) {
        throw "Self-test changed an absolute output path"
    }
    $relativeOutput = "word-acceptance-self-test"
    $expectedRelativeOutput = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $relativeOutput))
    if ((Resolve-OutputDirectoryPath $relativeOutput) -ne $expectedRelativeOutput) {
        throw "Self-test did not resolve a relative output path"
    }
    if (-not (Test-WordActivationEvidence -VNextOutput '{"LicenseState":"Licensed"}')) {
        throw "Self-test rejected licensed vNext evidence"
    }
    if (-not (Test-WordActivationEvidence -OsppOutput 'LICENSE STATUS:  ---LICENSED---')) {
        throw "Self-test rejected licensed OSPP evidence"
    }
    if (Test-WordActivationEvidence -VNextOutput 'No licenses found.' -OsppOutput '<No installed product keys detected>') {
        throw "Self-test accepted missing Office activation evidence"
    }
    Write-Output "Word DOCX acceptance self-test passed."
}

if ($SelfTest) {
    Invoke-SelfTest
    exit 0
}

$probe = $null
$wordApplicationPath = ""
try {
    $probe = Open-VerifiedWord
    $wordApplicationPath = $probe.Evidence.ApplicationPath
    Write-Output "Verified Microsoft Word $($probe.Evidence.Version) with a valid Microsoft Authenticode signature."
} finally {
    if ($null -ne $probe) {
        Close-WordApplication -Application $probe.Application -WordProcessId $probe.ProcessId
    }
}
if ($ProbeOnly) {
    exit 0
}

Assert-WordActivated -ApplicationPath $wordApplicationPath

$resolvedInput = (Resolve-Path -LiteralPath $InputDirectory).Path
if (-not (Test-Path -LiteralPath $resolvedInput -PathType Container)) {
    throw "InputDirectory must be an existing directory"
}
$outputFullPath = Resolve-OutputDirectoryPath $OutputDirectory
if (Test-Path -LiteralPath $outputFullPath) {
    throw "OutputDirectory must not already exist"
}
$outputParent = Split-Path -Parent $outputFullPath
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) {
    throw "OutputDirectory parent must already exist"
}
if ([StringComparer]::OrdinalIgnoreCase.Equals($resolvedInput.TrimEnd('\'), $outputFullPath.TrimEnd('\'))) {
    throw "InputDirectory and OutputDirectory must be different"
}

$files = @(Get-ChildItem -LiteralPath $resolvedInput -File -Filter "*.docx" | Sort-Object Name)
$corpusErrors = Test-CorpusNames -Names @($files.Name)
if ($corpusErrors.Count -gt 0) {
    throw "DOCX corpus validation failed: $($corpusErrors -join '; ')"
}

$sourceHashes = @{}
foreach ($file in $files) {
    $sourceHashes[$file.FullName] = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
}
New-Item -ItemType Directory -Path $outputFullPath | Out-Null

$results = [Collections.Generic.List[object]]::new()
$engine = $null
foreach ($file in $files) {
    $mode = if ($file.Name -match "-(translated|bilingual)\.docx$") { $Matches[1] } else { "unknown" }
    $pdfName = "$($file.BaseName).pdf"
    $pdfPath = Join-Path $outputFullPath $pdfName
    $session = $null
    $document = $null
    $status = "passed"
    $pages = 0
    $pdfBytes = 0
    try {
        $session = Open-VerifiedWord
        if ($null -eq $engine) {
            $engine = [PSCustomObject]@{
                name = $session.Evidence.Name
                version = $session.Evidence.Version
                company = $session.Evidence.CompanyName
                signatureStatus = $session.Evidence.SignatureStatus
            }
        }
        $document = $session.Application.Documents.Open($file.FullName, $false, $true, $false)
        $pages = [int]$document.ComputeStatistics($wordStatisticPages)
        $document.ExportAsFixedFormat($pdfPath, $wordPdfFormat)
        $pdfBytes = (Get-Item -LiteralPath $pdfPath).Length
        if ($pdfBytes -le 0 -or $pages -le 0) {
            $status = "invalid-export"
        }
    } catch {
        $status = "export-failed"
    } finally {
        if ($null -ne $document) {
            try { $document.Close(0) } catch {}
        }
        if ($null -ne $session) {
            Close-WordApplication -Application $session.Application -WordProcessId $session.ProcessId
        }
        Close-ComObject $document
    }
    $afterHash = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    if ($afterHash -ne $sourceHashes[$file.FullName]) {
        $status = "source-hash-changed"
    }
    $results.Add([PSCustomObject]@{
        file = $file.Name
        mode = $mode
        sha256 = $sourceHashes[$file.FullName]
        pdf = $pdfName
        pages = $pages
        pdfBytes = $pdfBytes
        status = $status
    })
}

$manifest = [ordered]@{
    schemaVersion = 1
    generatedAtUtc = [DateTime]::UtcNow.ToString("o")
    engine = $engine
    cases = $results
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outputFullPath "word-render-manifest.json") -Encoding UTF8

$reviewLines = [Collections.Generic.List[string]]::new()
$reviewLines.Add("# Microsoft Word DOCX visual review")
$reviewLines.Add("")
$reviewLines.Add("Engine: Microsoft Word $($engine.version)")
$reviewLines.Add("")
$reviewLines.Add("| Document | Mode | Opens without repair | Text/order | Tables/lists/links | Images/headers/footers | Result |")
$reviewLines.Add("|---|---|---|---|---|---|---|")
foreach ($result in $results) {
    $reviewLines.Add("| $($result.file) | $($result.mode) | Pending | Pending | Pending | Pending | Pending |")
}
$reviewLines.Add("")
$reviewLines.Add("Do not mark this review complete until every exported PDF page has been inspected and every DOCX has been opened visibly without a repair prompt in Microsoft Word.")
$reviewLines | Set-Content -LiteralPath (Join-Path $outputFullPath "review.md") -Encoding UTF8

$failures = @($results | Where-Object { $_.status -ne "passed" })
if ($failures.Count -gt 0) {
    throw "Microsoft Word export failed for $($failures.Count) document(s); inspect the redacted manifest"
}
Write-Output "Microsoft Word exported $($results.Count) DOCX files to $outputFullPath. Complete review.md after inspecting every page."
