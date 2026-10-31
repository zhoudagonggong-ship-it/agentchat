# 测一下 Windows 自带的语音识别：说三句话，看认得准不准、说完之后多久出字。
# 只用 Windows 自带的功能，不装任何东西。需要联网，并在「设置 → 隐私和安全性 → 语音」里打开「联机语音识别」。
#   双击 speech-test.cmd，或：powershell -ExecutionPolicy Bypass -File speech-test.ps1
$null = [Windows.Media.SpeechRecognition.SpeechRecognizer, Windows.Media, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }

$log = Join-Path ([Environment]::GetFolderPath('Desktop')) 'speech-test-log.txt'
function Note([string]$line) { Add-Content -Path $log -Value ((Get-Date -Format 'HH:mm:ss') + '  ' + $line) -Encoding UTF8 }
Note '==== 开始测试'

# 先录 3 秒，看麦克风有没有收到声音（Windows 自带的录音功能）。
Add-Type -Namespace W -Name Mci -MemberDefinition '[System.Runtime.InteropServices.DllImport("winmm.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern int mciSendString(string cmd, System.Text.StringBuilder ret, int len, System.IntPtr cb);'
$wav = Join-Path $env:TEMP 'speech-test-level.wav'
Write-Host ''
Write-Host '先测麦克风音量：看到「请说话」后，连续说 3 秒。' -ForegroundColor Cyan
Start-Sleep 1
Write-Host '请说话（3 秒）……' -ForegroundColor Yellow
[void][W.Mci]::mciSendString('open new type waveaudio alias lvl', $null, 0, [IntPtr]::Zero)
[void][W.Mci]::mciSendString('set lvl bitspersample 16 samplespersec 16000 channels 1', $null, 0, [IntPtr]::Zero)
[void][W.Mci]::mciSendString('record lvl', $null, 0, [IntPtr]::Zero)
Start-Sleep 3
[void][W.Mci]::mciSendString("save lvl `"$wav`"", $null, 0, [IntPtr]::Zero)
[void][W.Mci]::mciSendString('close lvl', $null, 0, [IntPtr]::Zero)
try {
  $bytes = [IO.File]::ReadAllBytes($wav)
  $peak = 0; $sum = 0.0; $n = 0
  for ($k = 44; $k + 1 -lt $bytes.Length; $k += 2) { $s = [Math]::Abs([BitConverter]::ToInt16($bytes, $k)); if ($s -gt $peak) { $peak = $s }; $sum += $s; $n++ }
  $peakPct = [Math]::Round($peak / 327.67); $avgPct = [Math]::Round($sum / [Math]::Max(1, $n) / 327.67, 1)
  $verdict = if ($peakPct -lt 2) { '几乎没有声音：麦克风没在收音（静音、音量太低，或者不是这个麦克风）' } elseif ($peakPct -lt 10) { '声音偏小' } else { '音量正常' }
  Write-Host ("麦克风音量：最大 {0}%，平均 {1}% → {2}" -f $peakPct, $avgPct, $verdict) -ForegroundColor Green
  Note ("mic level: peak {0}% avg {1}% ({2} samples) -> {3}" -f $peakPct, $avgPct, $n, $verdict)
} catch { Write-Host "测音量失败：$($_.Exception.Message)" -ForegroundColor Red; Note "mic level failed: $($_.Exception.Message)" }

$r = New-Object Windows.Media.SpeechRecognition.SpeechRecognizer (New-Object Windows.Globalization.Language 'zh-CN')
$r.Timeouts.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(600) # 停顿多久算说完
$c = Await ($r.CompileConstraintsAsync()) ([Windows.Media.SpeechRecognition.SpeechRecognitionCompilationResult])
if ("$($c.Status)" -ne 'Success') { Write-Host "语音识别启动失败：$($c.Status)" -ForegroundColor Red; Read-Host '按回车退出'; exit 1 }

Write-Host ''
Write-Host '测试 Windows 自带语音识别：一共三句。看到「请说话」后，说一句话，说完停一下。' -ForegroundColor Cyan
$total = @()
foreach ($i in 1..3) {
  Write-Host ''
  Write-Host "第 $i 句：请说话……" -ForegroundColor Yellow
  try {
    $res = Await ($r.RecognizeAsync()) ([Windows.Media.SpeechRecognition.SpeechRecognitionResult])
  } catch {
    $msg = "$($_.Exception.InnerException.Message) $($_.Exception.Message)"
    Note "round ${i}: error $msg"
    if ($msg -match '0x80045509|privacy|隐私') { Write-Host '需要先打开「设置 → 隐私和安全性 → 语音 → 联机语音识别」，再重新运行。' -ForegroundColor Red }
    else { Write-Host "识别出错：$msg" -ForegroundColor Red }
    break
  }
  $done = [DateTimeOffset]::Now
  if (-not $res.Text) {
    $why = @{ NetworkFailure = '连不上微软的识别服务（网络问题）'; AudioQualityFailure = '录到的声音太小或太杂'; TimeoutExceeded = '一直没听到说话'
      MicrophoneUnavailable = '麦克风用不了'; TopicLanguageNotSupported = '不支持中文听写'; GrammarCompilationFailure = '识别规则出错'
      UserCanceled = '被取消'; Success = '听到了但没认出字（声音可能太小）'; Unknown = '原因不明' }["$($res.Status)"]
    Write-Host ("没认出内容：{0}（{1}）" -f $why, $res.Status) -ForegroundColor DarkYellow
    Note ("round {0}: no text, status {1}, confidence {2}, duration {3:N1}s" -f $i, $res.Status, $res.Confidence, $res.PhraseDuration.TotalSeconds)
    continue
  }
  Note ("round {0}: status {1}, confidence {2}, text: {3}" -f $i, $res.Status, $res.Confidence, $res.Text)
  # 说完的那一刻 = 开始说话的时间 + 这句话的长度；之后到出字的这段，就是要等的时间。
  $spokeEnd = $res.PhraseStartTime + $res.PhraseDuration
  $wait = ($done - $spokeEnd).TotalSeconds
  $total += $wait
  Write-Host ("认出来：{0}" -f $res.Text) -ForegroundColor Green
  Write-Host ("说了 {0:N1} 秒，说完后 {1:N2} 秒出字（其中约 0.6 秒是在等你停顿）" -f $res.PhraseDuration.TotalSeconds, $wait)
}
if ($total.Count) { Write-Host ''; Write-Host ("平均：说完后 {0:N2} 秒出字" -f (($total | Measure-Object -Average).Average)) -ForegroundColor Cyan }
$r.Dispose()
Write-Host ''
Read-Host '测完了，按回车退出'
