Set ws = CreateObject("WScript.Shell")
Set lnk = ws.CreateShortcut(ws.SpecialFolders("Desktop") & "\ASO OT System.lnk")
lnk.TargetPath = "wscript.exe"
lnk.Arguments = """C:\Users\awisn\OneDrive\Desktop\Overtime App\start.vbs"""
lnk.WorkingDirectory = "C:\Users\awisn\OneDrive\Desktop\Overtime App"
lnk.Description = "ASO Staff OT System"
lnk.IconLocation = "shell32.dll,23"
lnk.Save

MsgBox "Done! Look for 'ASO OT System' on your Desktop.", 64, "ASO Shortcut"
