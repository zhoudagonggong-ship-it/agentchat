# 语音识别听不到时，查这台电脑的麦克风和语音设置（只读，不改任何东西）。
$cs = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
$lm = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
'麦克风总开关（本机）: ' + (Get-ItemProperty $lm -ErrorAction SilentlyContinue).Value
'麦克风总开关（本用户）: ' + (Get-ItemProperty $cs -ErrorAction SilentlyContinue).Value
'允许桌面应用访问麦克风: ' + (Get-ItemProperty (Join-Path $cs 'NonPackaged') -ErrorAction SilentlyContinue).Value
'联机语音识别: ' + (Get-ItemProperty 'HKCU:\Software\Microsoft\Speech_OneCore\Settings\OnlineSpeechPrivacy' -ErrorAction SilentlyContinue).HasAccepted
'录音设备: '
Get-PnpDevice -Class AudioEndpoint -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match '麦克风|Microphone|Mic|阵列|Array|输入|Input|耳机|Headset' } | ForEach-Object { '   ' + $_.FriendlyName + ' [' + $_.Status + ']' }
# Which capture device is the default one (the one recognition listens to).
$cap = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture'
Get-ChildItem $cap -ErrorAction SilentlyContinue | ForEach-Object {
  $state = (Get-ItemProperty $_.PSPath).DeviceState
  $name = (Get-ItemProperty (Join-Path $_.PSPath 'Properties') -ErrorAction SilentlyContinue).'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
  if ($state -eq 1) { '   启用中的录音设备: ' + $name }
}
