' Runs a program without flashing a console window.
' Usage: wscript.exe hidden.vbs <program> [arguments...]
Dim shell, command, i
Set shell = CreateObject("WScript.Shell")
command = ""
For i = 0 To WScript.Arguments.Count - 1
  command = command & """" & WScript.Arguments(i) & """ "
Next
shell.Run Trim(command), 0, False
