' ============================================================
' ASO Staff OT System — Silent Launcher (Fixed)
' Double-click this file to start the server and open the app.
' ============================================================

Option Explicit

Dim wsh, fso, appDir, nodePath, serverPath, cmd, http, ready, i

Set wsh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' ── Resolve the folder this script lives in ───────────────
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
serverPath = appDir & "\server.js"

' ── Sanity check ──────────────────────────────────────────
If Not fso.FileExists(serverPath) Then
    MsgBox "Cannot find server.js in:" & vbCrLf & appDir & vbCrLf & vbCrLf & _
           "Make sure start.vbs is in the same folder as server.js.", _
           vbCritical, "ASO OT System"
    WScript.Quit
End If

' ── Find Node.js ──────────────────────────────────────────
nodePath = ""

' 1. Check for portable node bundled in app folder
If fso.FileExists(appDir & "\node\node.exe") Then
    nodePath = appDir & "\node\node.exe"
End If

' 2. Check standard Node install registry key
If nodePath = "" Then
    On Error Resume Next
    Dim regVal
    regVal = wsh.RegRead("HKLM\SOFTWARE\Node.js\InstallPath")
    If Err.Number = 0 And regVal <> "" Then
        If fso.FileExists(regVal & "node.exe") Then
            nodePath = regVal & "node.exe"
        ElseIf fso.FileExists(regVal & "\node.exe") Then
            nodePath = regVal & "\node.exe"
        End If
    End If
    On Error GoTo 0
End If

' 3. Fallback — rely on PATH
If nodePath = "" Then
    nodePath = "node.exe"
End If

' ── Kill any stale node server on port 8420 ───────────────
On Error Resume Next
wsh.Run "cmd /c for /f ""tokens=5"" %a in ('netstat -aon ^| findstr :8420') do taskkill /F /PID %a", 0, True
On Error GoTo 0
WScript.Sleep 800

' ── Start the server hidden ───────────────────────────────
cmd = """" & nodePath & """ """ & serverPath & """"
wsh.CurrentDirectory = appDir
wsh.Run cmd, 0, False   ' 0 = hidden, False = don't wait

' ── Poll until server is ready (up to 15 seconds) ─────────
Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
ready = False
For i = 1 To 30
    WScript.Sleep 500
    On Error Resume Next
    http.Open "GET", "http://localhost:8420/api/health", False
    http.Send
    If Err.Number = 0 And http.Status = 200 Then
        ready = True
        Exit For
    End If
    On Error GoTo 0
Next

' ── Open browser ──────────────────────────────────────────
If ready Then
    wsh.Run "http://localhost:8420"
Else
    MsgBox "The server is taking longer than expected." & vbCrLf & _
           "The browser will open anyway — if the page is blank, wait a few seconds and refresh." & vbCrLf & vbCrLf & _
           "URL: http://localhost:8420", vbInformation, "ASO OT System"
    wsh.Run "http://localhost:8420"
End If

' ── Cleanup ───────────────────────────────────────────────
Set wsh  = Nothing
Set fso  = Nothing
Set http = Nothing
