[CmdletBinding()]
param(
    [ValidateSet('preview', 'basic', 'emotion')][string]$Profile = 'basic',
    [switch]$NoGui,
    [switch]$AcceptEmotionLicense,
    [switch]$SkipModels,
    [string]$ModelCache = '',
    [switch]$Worker,
    [string]$LogPath = ''
)

# Windows PowerShell 5.1 compatible. Every runtime/cache is local to this copy.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $Root
$Utf8 = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8
$OutputEncoding = $Utf8
$Manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'distribution_manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json

function Write-InstallLog([string]$Text) {
    $line = '[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $Text
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        try {
            [IO.File]::AppendAllText($script:LogPath, $line + [Environment]::NewLine, $script:Utf8)
            break
        } catch [IO.IOException] {
            if ($attempt -eq 3) { throw }
            Start-Sleep -Milliseconds 50
        }
    }
    if ($script:NoGui -and -not $script:Worker) { Write-Host $line }
}

function Read-SharedInstallLog([string]$Path) {
    $stream = $null
    $reader = $null
    try {
        $sharing = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        $stream = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $sharing)
        $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
        return $reader.ReadToEnd()
    } catch [IO.IOException] { return $null }
    finally {
        if ($reader) { $reader.Dispose() }
        elseif ($stream) { $stream.Dispose() }
    }
}

function Invoke-InstallCommand([string]$Executable, [string[]]$Arguments) {
    Write-InstallLog ('运行：' + [IO.Path]::GetFileName($Executable) + ' ' + ($Arguments -join ' '))
    # Native stderr contains normal uv progress. Check its exit code explicitly.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Executable @Arguments 2>&1 | ForEach-Object { Write-InstallLog ([string]$_) }
        $commandExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($commandExit -ne 0) { throw "安装步骤失败（退出码 $commandExit）。请查看上方日志，检查网络后重新运行安装器。" }
}

function Get-VerifiedArchive([string]$Url, [string]$Sha256, [string]$Name) {
    $directory = Join-Path $Root 'cache/downloads'
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $archive = Join-Path $directory $Name
    if ((Test-Path -LiteralPath $archive) -and (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -eq $Sha256) {
        Write-InstallLog "复用已校验安装包：$Name"
        return $archive
    }
    $partial = $archive + '.part'
    # Runtimes are modest archives. Interrupted model downloads use resumable ranges
    # in setup_distribution.py; these archives are retried from the same official URL.
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Write-InstallLog "下载安装包 $Name（第 $attempt 次）：$Url"
            Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $partial -TimeoutSec 180
            if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $Sha256) {
                throw '安装包 SHA256 校验不一致，拒绝执行。'
            }
            Move-Item -LiteralPath $partial -Destination $archive -Force
            return $archive
        } catch {
            if ($attempt -eq 3) { throw }
            Write-InstallLog $_.Exception.Message
            Start-Sleep -Seconds 2
        }
    }
}

function Install-PythonEnvironment([string]$Version, [string]$Name) {
    $environment = Join-Path $Root $Name
    $python = Join-Path $environment 'Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $python)) {
        Invoke-InstallCommand $script:Uv @('python', 'install', $Version, '--no-bin', '--no-registry', '--no-config')
        Invoke-InstallCommand $script:Uv @('venv', '--python', $Version, '--no-config', $environment)
    } else {
        Invoke-InstallCommand $python @('-c', "import sys; assert sys.version_info[:2] == tuple(map(int, '$Version'.split('.')[:2])), 'Existing environment has incompatible Python'")
    }
    return $python
}

function Test-RuntimeCommand([string]$Executable, [string[]]$Arguments) {
    if (-not (Test-Path -LiteralPath $Executable) -or [IO.Path]::GetExtension($Executable) -ne '.exe') { return $false }
    $process = New-Object Diagnostics.Process
    $process.StartInfo.FileName = $Executable
    # All callers supply fixed internal arguments, including a quoted import probe.
    $process.StartInfo.Arguments = $Arguments -join ' '
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    try {
        if (-not $process.Start()) { return $false }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) {
            $process.Kill()
            $process.WaitForExit(2000) | Out-Null
            return $false
        }
        return ($process.ExitCode -eq 0)
    } catch { return $false }
    finally { $process.Dispose() }
}

function Install-Ffmpeg {
    $destination = Join-Path $Root 'runtime/ffmpeg'
    if (-not (Test-RuntimeCommand (Join-Path $destination 'bin/ffmpeg.exe') @('-version')) -or
        -not (Test-RuntimeCommand (Join-Path $destination 'bin/ffprobe.exe') @('-version'))) {
        $archive = Get-VerifiedArchive $Manifest.ffmpeg.url $Manifest.ffmpeg.sha256 ('ffmpeg-' + $Manifest.ffmpeg.version + '.zip')
        $unpack = Join-Path $Root ('cache/downloads/ffmpeg-' + $Manifest.ffmpeg.version)
        Expand-Archive -LiteralPath $archive -DestinationPath $unpack -Force
        $binary = Get-ChildItem -LiteralPath $unpack -Filter ffmpeg.exe -File -Recurse | Select-Object -First 1
        if (-not $binary) { throw 'FFmpeg 安装包没有找到 ffmpeg.exe。请检查发行包清单。' }
        New-Item -ItemType Directory -Force -Path $destination | Out-Null
        Copy-Item -LiteralPath (Join-Path $binary.Directory.Parent.FullName 'bin') -Destination $destination -Recurse -Force
        Get-ChildItem -LiteralPath $binary.Directory.Parent.FullName -File | Copy-Item -Destination $destination -Force
    }
    Invoke-InstallCommand (Join-Path $destination 'bin/ffmpeg.exe') @('-version')
    Invoke-InstallCommand (Join-Path $destination 'bin/ffprobe.exe') @('-version')
    $env:PATH = (Join-Path $destination 'bin') + [IO.Path]::PathSeparator + $env:PATH
}

function Install-EmotionSource {
    $destination = Join-Path $Root 'upstream/indextts'
    $marker = Join-Path $destination '.distribution-revision'
    if (Test-Path -LiteralPath $destination) {
        if ((Test-Path -LiteralPath $marker) -and
            ((Get-Content -LiteralPath $marker -Raw).Trim() -eq $Manifest.emotion_source.revision)) { return }
        throw 'upstream/indextts 已有来源未标记的文件。为保护本地修改，安装器不会覆盖；请在新解压的发行目录安装情绪引擎。'
    }
    $archive = Get-VerifiedArchive $Manifest.emotion_source.url $Manifest.emotion_source.sha256 ('indextts-' + $Manifest.emotion_source.revision + '.zip')
    $unpack = Join-Path $Root ('cache/downloads/indextts-' + $Manifest.emotion_source.revision)
    Expand-Archive -LiteralPath $archive -DestinationPath $unpack -Force
    $source = Join-Path $unpack ('index-tts-' + $Manifest.emotion_source.revision)
    if (-not (Test-Path -LiteralPath (Join-Path $source 'indextts/infer_v2_5.py'))) { throw 'IndexTTS 源码包结构不符合固定版本。' }
    # A cancelled copy never creates an ambiguous final directory. Each attempt
    # stages beside the destination, then commits it with one same-volume rename.
    $upstreamRoot = [IO.Path]::GetFullPath((Join-Path $Root 'upstream'))
    $staging = Join-Path $upstreamRoot ('indextts-install-' + [Guid]::NewGuid().ToString('N'))
    Copy-Item -LiteralPath $source -Destination $staging -Recurse -Force
    if (-not (Test-Path -LiteralPath (Join-Path $staging 'indextts/infer_v2_5.py')) -or
        -not (Test-Path -LiteralPath (Join-Path $staging 'LICENSE'))) { throw '情绪引擎源码未复制完整，请重新安装。' }
    [IO.File]::WriteAllText((Join-Path $staging '.distribution-revision'), $Manifest.emotion_source.revision, $Utf8)
    $resolvedStaging = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $staging).Path)
    if ([IO.Path]::GetDirectoryName($resolvedStaging) -ne $upstreamRoot -or
        [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($destination)) -ne $upstreamRoot) {
        throw '源码安装目录不在当前工作台内，已停止。'
    }
    Rename-Item -LiteralPath $resolvedStaging -NewName 'indextts' -ErrorAction Stop
}

function Get-RequiredFreeBytes([string]$InstallProfile, [bool]$BaseExists, [bool]$EmotionExists) {
    if ($InstallProfile -eq 'emotion' -and -not $EmotionExists) { return 40GB }
    if (-not $BaseExists) {
        if ($InstallProfile -eq 'preview') { return 12GB }
        return 20GB
    }
    return 0
}

function Install-BaseTorch([string]$Python) {
    if ($Profile -eq 'preview') {
        if (Test-RuntimeCommand $Python @('-c', '"import torch"')) {
            Write-InstallLog '已有可导入的 PyTorch，仅试听模式保留当前版本，不替换已有 CUDA 环境。'
            return
        }
        Write-InstallLog '仅试听模式安装 CPU 版 PyTorch，不下载 CUDA 运行库。'
        Invoke-InstallCommand $script:Uv @('pip', 'install', '--python', $Python, '--no-deps', '--index-url', 'https://download.pytorch.org/whl/cpu', 'torch==2.6.0', 'torchaudio==2.6.0')
        return
    }
    Write-InstallLog '配音模式安装固定 CUDA 12.4 版 PyTorch，支持后续本地 NVIDIA 推理。'
    Invoke-InstallCommand $script:Uv @('pip', 'install', '--python', $Python, '--no-deps', '--index-url', 'https://download.pytorch.org/whl/cu124', 'torch==2.6.0+cu124', 'torchaudio==2.6.0+cu124')
}

function Assert-NoRunningInstance {
    $recordPath = Join-Path $Root 'data/server.json'
    if (-not (Test-Path -LiteralPath $recordPath)) { return }
    $response = $null
    $reader = $null
    $identity = $null
    try {
        $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $port = 0
        if (-not [int]::TryParse([string]$record.port, [ref]$port) -or $port -lt 1024 -or $port -gt 65535) { return }
        $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$port/local/identity")
        $request.Proxy = $null
        $request.Timeout = 1500
        $request.ReadWriteTimeout = 1500
        $response = $request.GetResponse()
        $reader = New-Object IO.StreamReader($response.GetResponseStream(), [Text.Encoding]::UTF8)
        $identity = $reader.ReadToEnd() | ConvertFrom-Json
        if ($identity.app -ne 'voice-workbench' -or $identity.root -isnot [string]) { return }
        $runningRoot = [IO.Path]::GetFullPath($identity.root).TrimEnd([char[]]'\/')
        $installRoot = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]'\/')
    } catch {
        # Missing, stale or foreign records must not prevent installation.
        return
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
    if ([string]::Equals($runningRoot, $installRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw '此目录的配音工作台正在运行。请先保存当前工作，双击「关闭配音工作台.vbs」，待服务关闭后再安装或升级。安装器不会自动停止生成任务或服务。'
    }
}

function Start-Installation {
    if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
        throw '此发行版支持 Windows 10/11 x64，请使用 x64 Windows 电脑。'
    }
    if ($Root.Length -gt 130) { throw '解压目录过深，可能超过 Windows 路径限制。请移到例如 D:\配音工作台 后重试。' }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'upstream/voicebox/frontend/index.html'))) {
        throw '缺少预编译界面。请重新下载完整发行 ZIP 或仓库源码 ZIP，并先完整解压后再运行安装器。'
    }
    if ($Profile -eq 'emotion' -and -not $AcceptEmotionLicense) {
        throw '情绪引擎需要明确同意其独立许可证。请运行安装情绪引擎.vbs 阅读并勾选同意；维护命令需显式传入 -AcceptEmotionLicense。'
    }
    Assert-NoRunningInstance
    $requiredBytes = Get-RequiredFreeBytes $Profile (Test-Path -LiteralPath (Join-Path $Root '.venv/Scripts/python.exe')) (Test-Path -LiteralPath (Join-Path $Root '.venv-emotion/Scripts/python.exe'))
    $disk = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($Root))
    if ($disk.AvailableFreeSpace -lt $requiredBytes) {
        throw ('磁盘剩余空间不足。首次安装此模式请至少预留 ' + ($requiredBytes / 1GB) + ' GB；当前剩余 ' + [Math]::Round($disk.AvailableFreeSpace / 1GB, 1) + ' GB。请将完整目录移到空间充足的磁盘后重试。')
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $Root 'runtime'), (Join-Path $Root 'cache/tmp'), (Join-Path $Root 'data') | Out-Null
    try {
        $script:InstallLock = [IO.File]::Open((Join-Path $Root 'data/installation.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch {
        throw '另一个安装器正在操作此目录。请等待其完成或关闭该安装窗口后重试。'
    }
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $Root 'runtime/python'
    $env:UV_CACHE_DIR = Join-Path $Root 'cache/uv'
    $env:UV_PYTHON_PREFERENCE = 'only-managed'
    $env:UV_NO_CONFIG = '1'
    $env:UV_LINK_MODE = 'copy'
    $env:NO_COLOR = '1'
    $env:TEMP = $env:TMP = Join-Path $Root 'cache/tmp'
    $env:PYTHONUTF8 = '1'
    $env:PYTHONIOENCODING = 'utf-8'
    $env:HF_HUB_DISABLE_TELEMETRY = '1'
    Write-InstallLog "安装位置：$Root；配置：$Profile。不会更改全局 Python、PATH 或显卡驱动。"
    $uvDirectory = Join-Path $Root 'runtime/uv'
    $script:Uv = Join-Path $uvDirectory 'uv.exe'
    if (-not (Test-RuntimeCommand $script:Uv @('--version'))) {
        $archive = Get-VerifiedArchive $Manifest.uv.url $Manifest.uv.sha256 ('uv-' + $Manifest.uv.version + '.zip')
        Expand-Archive -LiteralPath $archive -DestinationPath $uvDirectory -Force
    }
    Invoke-InstallCommand $script:Uv @('--version')
    $python = Install-PythonEnvironment $Manifest.python '.venv'
    Write-InstallLog '安装固定版本基础依赖。首次下载包含 PyTorch，可能需要较长时间；重试会复用缓存。'
    Install-BaseTorch $python
    $basicLock = Join-Path $Root 'cache/basic-packages.txt'
    $lines = Get-Content -LiteralPath (Join-Path $Root 'requirements-lock.txt') | Where-Object { $_ -notmatch '^torch(audio)?==' }
    [IO.File]::WriteAllLines($basicLock, [string[]]$lines, $Utf8)
    Invoke-InstallCommand $script:Uv @('pip', 'install', '--python', $python, '--no-deps', '--index-url', 'https://pypi.org/simple', '-r', $basicLock)
    Install-Ffmpeg
    Invoke-InstallCommand $python @((Join-Path $PSScriptRoot 'setup_distribution.py'), 'check-base')
    Invoke-InstallCommand $python @((Join-Path $PSScriptRoot 'setup_distribution.py'), 'init')
    if ($Profile -ne 'preview' -and -not $SkipModels) {
        Invoke-InstallCommand $python @((Join-Path $PSScriptRoot 'setup_distribution.py'), 'check-cuda')
        $modelArguments = @((Join-Path $PSScriptRoot 'setup_distribution.py'), 'models')
        if ($ModelCache) { $modelArguments += @('--model-cache', $ModelCache) }
        Invoke-InstallCommand $python $modelArguments
    }
    if ($Profile -eq 'emotion') {
        Write-InstallLog '已明确同意情绪引擎独立条款，准备固定版本源码及独立 Python 3.11 环境。'
        Install-EmotionSource
        $emotionPython = Install-PythonEnvironment $Manifest.emotion_python '.venv-emotion'
        Invoke-InstallCommand $script:Uv @('pip', 'install', '--python', $emotionPython, '--no-deps', '--require-hashes', '--index-url', 'https://pypi.org/simple', '-r', (Join-Path $Root 'runtime-emotion/requirements-lock.txt'))
        if (-not $SkipModels) {
            Invoke-InstallCommand $python @((Join-Path $PSScriptRoot 'setup_emotion.py'))
            foreach ($cacheDirectory in @('cache/emotion', 'cache/emotion/nltk_data', 'cache/emotion/matplotlib', 'cache/emotion/torch', 'cache/emotion/numba', 'cache/emotion/temp')) {
                New-Item -ItemType Directory -Force -Path (Join-Path $Root $cacheDirectory) | Out-Null
            }
            Invoke-InstallCommand $emotionPython @((Join-Path $Root 'runtime-emotion/check_import.py'))
            Invoke-InstallCommand $python @((Join-Path $PSScriptRoot 'setup_distribution.py'), 'emotion-complete')
        }
    }
    $record = @{ profile = $Profile; skip_models = [bool]$SkipModels; completed_at = (Get-Date).ToString('o'); emotion_license_accepted = [bool]$AcceptEmotionLicense; manifest = 'scripts/distribution_manifest.json' }
    [IO.File]::WriteAllText((Join-Path $Root 'data/installation.json'), ($record | ConvertTo-Json), $Utf8)
    Write-InstallLog '安装完成。双击「打开配音工作台.vbs」即可使用；仅试听模式暂不支持新语音生成。'
}

function Show-Installer {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [Windows.Forms.Application]::EnableVisualStyles()
    $script:Form = New-Object Windows.Forms.Form
    $Form.Text = '配音工作台 · 首次安装'
    $Form.ClientSize = New-Object Drawing.Size(780, 580)
    $Form.StartPosition = 'CenterScreen'
    $Form.MinimumSize = $Form.Size
    $Form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
    $intro = New-Object Windows.Forms.Label
    $intro.Text = "首次联网安装，无需预装 Python / Git / Node。基础预留 20 GB，情绪引擎预留 40 GB。`r`n独立环境无需管理员；显卡驱动/系统运行库依系统权限。27 段情绪试听适用独立条款。"
    $intro.SetBounds(20, 16, 740, 54)
    $Form.Controls.Add($intro)
    $script:Choice = New-Object Windows.Forms.ComboBox
    $Choice.DropDownStyle = 'DropDownList'
    $Choice.Items.AddRange(@('基础配音：角色音色与声音克隆（NVIDIA 6 GB 起）', '仅试听：安装界面与样音，不下载语音模型', '情绪引擎：基础配音 + 指定/自动情绪（额外下载）'))
    $Choice.SelectedIndex = @{ basic = 0; preview = 1; emotion = 2 }[$Profile]
    $Choice.SetBounds(20, 82, 740, 32)
    $Form.Controls.Add($Choice)
    $terms = New-Object Windows.Forms.LinkLabel
    $terms.Text = '阅读第三方许可说明 / IndexTTS 模型使用协议'
    $terms.SetBounds(20, 128, 720, 24)
    $terms.Add_LinkClicked({
        $license = Join-Path $Root 'THIRD_PARTY_NOTICES.md'
        if (Test-Path -LiteralPath $license) { Start-Process -FilePath notepad.exe -ArgumentList ('"' + $license + '"') }
        Start-Process -FilePath $Manifest.emotion_source.license_url
    })
    $Form.Controls.Add($terms)
    $script:Consent = New-Object Windows.Forms.CheckBox
    $Consent.Text = '我已阅读并同意 IndexTTS 及其组件的独立许可条款（仅情绪引擎需要）'
    $Consent.SetBounds(20, 157, 740, 30)
    $Consent.Checked = $false
    $Form.Controls.Add($Consent)
    $script:Progress = New-Object Windows.Forms.ProgressBar
    $Progress.SetBounds(20, 199, 740, 16)
    $Progress.Style = 'Blocks'
    $Form.Controls.Add($Progress)
    $script:LogBox = New-Object Windows.Forms.TextBox
    $LogBox.Multiline = $true
    $LogBox.ReadOnly = $true
    $LogBox.ScrollBars = 'Vertical'
    $LogBox.SetBounds(20, 228, 740, 274)
    $LogBox.Text = "点击开始后下载固定版本环境和模型。`r`n中断后重新安装会复用完整文件，模型支持断点续传。"
    $Form.Controls.Add($LogBox)
    $script:BeginButton = New-Object Windows.Forms.Button
    $BeginButton.Text = '开始安装'
    $BeginButton.SetBounds(470, 524, 135, 34)
    $Form.Controls.Add($BeginButton)
    $script:CloseButton = New-Object Windows.Forms.Button
    $CloseButton.Text = '关闭'
    $CloseButton.SetBounds(625, 524, 135, 34)
    $CloseButton.Add_Click({ $Form.Close() })
    $Form.Controls.Add($CloseButton)
    $script:InstallProcess = $null
    $script:Timer = New-Object Windows.Forms.Timer
    $Timer.Interval = 500
    $Timer.Add_Tick({
        if (Test-Path -LiteralPath $script:GuiLog) {
            $text = Read-SharedInstallLog $script:GuiLog
            if ($null -ne $text) {
                if ($text.Length -gt 20000) { $text = $text.Substring($text.Length - 20000) }
                if ($LogBox.Text -ne $text) { $LogBox.Text = $text; $LogBox.SelectionStart = $LogBox.TextLength; $LogBox.ScrollToCaret() }
            }
        }
        if ($InstallProcess -and $InstallProcess.HasExited) {
            $Timer.Stop(); $Progress.Style = 'Blocks'; $BeginButton.Enabled = $true; $Choice.Enabled = $true; $Consent.Enabled = $true
            $CloseButton.Text = '关闭'
            if ($InstallProcess.ExitCode -eq 0) {
                $Progress.Value = 100
                [Windows.Forms.MessageBox]::Show('安装完成。现在可双击「打开配音工作台.vbs」使用。', '配音工作台')
            } else {
                [Windows.Forms.MessageBox]::Show("安装未完成。请查看窗口日志；检查网络、磁盘空间或 NVIDIA 驱动后重试。`r`n完整日志：$script:GuiLog", '配音工作台')
            }
        }
    })
    $BeginButton.Add_Click({
        $selected = @('basic', 'preview', 'emotion')[$Choice.SelectedIndex]
        if ($selected -eq 'emotion' -and -not $Consent.Checked) {
            [Windows.Forms.MessageBox]::Show('请先阅读许可说明并勾选同意，或选择基础配音/仅试听。', '配音工作台')
            return
        }
        $script:GuiLog = Join-Path $Root ('logs/setup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.log')
        New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs') | Out-Null
        $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '" -Worker -NoGui -Profile ' + $selected + ' -LogPath "' + $script:GuiLog + '"'
        if ($selected -eq 'emotion') { $arguments += ' -AcceptEmotionLicense' }
        $script:InstallProcess = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru
        $BeginButton.Enabled = $false; $Choice.Enabled = $false; $Consent.Enabled = $false; $CloseButton.Text = '停止安装'
        $Progress.Style = 'Marquee'; $Timer.Start()
    })
    $Form.Add_FormClosing({
        if ($InstallProcess -and -not $InstallProcess.HasExited) {
            $answer = [Windows.Forms.MessageBox]::Show('停止当前安装？已下载文件会保留，下次可继续。', '配音工作台', 'YesNo', 'Question')
            if ($answer -ne 'Yes') { $_.Cancel = $true; return }
            # Stop only the installer process and its children, never other apps.
            $killer = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/taskkill.exe') -ArgumentList @('/PID', [string]$InstallProcess.Id, '/T', '/F') -WindowStyle Hidden -PassThru
            $killer.WaitForExit()
        }
        $Timer.Stop()
    })
    $Form.ShowDialog() | Out-Null
    $Timer.Dispose(); $Form.Dispose()
}

if (-not $NoGui -and -not $Worker) { Show-Installer; exit 0 }
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs') | Out-Null
if (-not $LogPath) { $LogPath = Join-Path $Root ('logs/setup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.log') }
try {
    Start-Installation
    exit 0
} catch {
    Write-InstallLog ('安装失败：' + $_.Exception.Message)
    Write-InstallLog '若日志出现 WinError 126/127/1114 或 DLL load failed，请安装微软 Visual C++ 2015-2022 x64 运行库后重试：https://aka.ms/vs/17/release/vc_redist.x64.exe'
    Write-InstallLog ('详细日志：' + $LogPath)
    exit 1
} finally {
    if ($script:InstallLock) { $script:InstallLock.Dispose() }
}
