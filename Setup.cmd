@echo off
rem Double-click to install AgentChat (no administrator rights needed).
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0src\setup\install.ps1"
