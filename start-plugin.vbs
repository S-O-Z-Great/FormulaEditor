' Hidden launcher for the formula plugin (tray app).
' Task Scheduler / double-click both go through here, so no console window flashes.
' Keep pure ASCII: wscript reads this file with the system code page.
Option Explicit

Dim sh, fso, root
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)

sh.CurrentDirectory = root
' The IDE preset makes electron.exe degrade into plain node; clear it for the child.
sh.Environment("Process")("ELECTRON_RUN_AS_NODE") = ""
sh.Run "node """ + root + "\scripts\start.js""", 0, False
