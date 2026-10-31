@echo off
rem 双击运行：语音输入诊断版（托盘里的黄色感叹号图标，右键可退出）
start "" powershell -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0voice-diag.ps1"
