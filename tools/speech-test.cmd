@echo off
rem 双击运行：测试 Windows 自带的语音识别
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0speech-test.ps1"
