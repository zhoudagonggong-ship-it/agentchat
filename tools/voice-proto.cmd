@echo off
rem 双击运行：语音输入小样（托盘图标右键可退出）
start "" powershell -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0voice-proto.ps1"
