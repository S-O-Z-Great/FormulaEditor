@echo off
rem Double-click this to start the formula plugin (tray app) if it is not running.
rem The real work is in start-plugin.vbs - it hides the console window.
wscript.exe "%~dp0start-plugin.vbs"
