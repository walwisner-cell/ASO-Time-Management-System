; ============================================================
; ASO Staff Overtime Management System — Inno Setup Script
; Produces a single signed .exe installer for Windows 10/11
;
; To compile:
;   1. Download Inno Setup from https://jrsoftware.org/isinfo.php
;   2. Open this file in the Inno Setup IDE
;   3. Click Build → Compile  (or press F9)
;   Output will be in the Output\ subfolder as ASO_OT_Setup.exe
; ============================================================

#define AppName      "ASO Staff OT System"
#define AppVersion   "9.2.0"
#define AppPublisher "American Safety Options"
#define AppURL       "http://localhost:8420"
#define AppExeName   "start.vbs"
#define RegKey       "SOFTWARE\ASO_OT_System"
#define NodeMinVer   "18.0.0"

[Setup]
; ── Identity ─────────────────────────────────────────────
AppId={{A3F7C2D1-4B88-4E90-9C11-ASO-OT-SYSTEM}}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} v{#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL=https://americansafetyoptions.com
AppSupportURL=https://americansafetyoptions.com
AppUpdatesURL=https://americansafetyoptions.com

; ── Install paths ────────────────────────────────────────
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
AllowNoIcons=no
OutputDir=Output
OutputBaseFilename=ASO_OT_Setup
SetupIconFile=aso_icon.ico
UninstallDisplayIcon={app}\aso_icon.ico

; ── Compression ──────────────────────────────────────────
Compression=lzma2/ultra64
SolidCompression=yes
LZMANumBlockThreads=4

; ── Appearance ───────────────────────────────────────────
WizardStyle=modern
WizardSizePercent=120
SetupLogging=yes

; ── Privileges ───────────────────────────────────────────
; 'lowest' allows install without admin rights
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

; ── Registry ─────────────────────────────────────────────
; Store install path so start.vbs can find it
ChangesEnvironment=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon";    Description: "Create a &desktop shortcut";    GroupDescription: "Shortcuts:"; Flags: checked
Name: "startmenuicon";  Description: "Create a &Start Menu shortcut"; GroupDescription: "Shortcuts:"; Flags: checked
Name: "startup";        Description: "Start server automatically at &Windows login (recommended)"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
; ── Application files ────────────────────────────────────
Source: "server.js";                   DestDir: "{app}"; Flags: ignoreversion
Source: "ASO_OT_SYSTEM_SQL.html";      DestDir: "{app}"; Flags: ignoreversion
Source: "start.vbs";                   DestDir: "{app}"; Flags: ignoreversion
Source: "package.json";                DestDir: "{app}"; Flags: ignoreversion
Source: "node_modules\*";              DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "aso_icon.ico";                DestDir: "{app}"; Flags: ignoreversion

; ── Optional: bundled portable Node.js ───────────────────
; Uncomment this block if you want to bundle Node.js so it
; works even on machines that don't have Node installed.
; Download the "Windows Binary (.zip)" from https://nodejs.org
; and extract it to a subfolder called "node" next to this .iss file.
;
; Source: "node\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
; Store install path for start.vbs
Root: HKLM; Subkey: "{#RegKey}"; ValueType: string; ValueName: "InstallDir"; ValueData: "{app}"; Flags: uninsdeletekey; Check: IsAdminInstallMode
Root: HKCU; Subkey: "{#RegKey}"; ValueType: string; ValueName: "InstallDir"; ValueData: "{app}"; Flags: uninsdeletekey; Check: not IsAdminInstallMode

[Icons]
; Desktop shortcut
Name: "{autodesktop}\{#AppName}";     Filename: "{sys}\wscript.exe"; Parameters: """{app}\start.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\aso_icon.ico"; Tasks: desktopicon; Comment: "Launch ASO Staff OT System"

; Start Menu
Name: "{group}\{#AppName}";           Filename: "{sys}\wscript.exe"; Parameters: """{app}\start.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\aso_icon.ico"; Tasks: startmenuicon
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"

[Run]
; Launch app after install
Filename: "{sys}\wscript.exe"; Parameters: """{app}\start.vbs"""; Description: "Launch {#AppName} now"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Stop the server before uninstalling
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM node.exe"; Flags: runhidden; RunOnceId: "KillNode"

[Registry]
; Optional: add to Windows startup (only if task selected)
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "ASO_OT_System"; ValueData: """{sys}\wscript.exe"" ""{app}\start.vbs"""; Flags: uninsdeletevalue; Tasks: startup

[Code]
// ── Check for Node.js before installing ───────────────────
function NodeIsInstalled(): Boolean;
var
  NodeVersion: String;
begin
  // Check registry for Node.js install path
  Result := RegKeyExists(HKLM, 'SOFTWARE\Node.js') or
            RegKeyExists(HKCU, 'SOFTWARE\Node.js');
  // Also try running node --version via Exec (handles PATH-only installs)
  if not Result then
  begin
    if Exec(ExpandConstant('{sys}\cmd.exe'), '/c node --version > nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, 0) then
      Result := True;
  end;
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not NodeIsInstalled() then
  begin
    if MsgBox(
      'Node.js is required but was not found on this computer.' + #13#10 + #13#10 +
      'Please install Node.js v18 or later from:' + #13#10 +
      'https://nodejs.org/en/download' + #13#10 + #13#10 +
      'Click OK to open the Node.js download page, then run this installer again.' + #13#10 +
      'Click Cancel to continue anyway (not recommended).',
      mbConfirmation, MB_OKCANCEL
    ) = IDOK then
    begin
      ShellExec('open', 'https://nodejs.org/en/download', '', '', SW_SHOW, ewNoWait, 0);
      Result := False;  // abort installer so user installs Node first
    end;
    // If Cancel: continue install anyway (bundled node will be used if present)
  end;
end;
