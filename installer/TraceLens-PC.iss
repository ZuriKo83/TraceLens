#ifndef TraceLensVersion
#define TraceLensVersion "0.2.0"
#endif

[Setup]
AppId=TraceLens.PCCollector
AppName=TraceLens
AppVersion={#TraceLensVersion}
AppPublisher=TraceLens
DefaultDirName={localappdata}\Programs\TraceLens PC Collector
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=TraceLens
Compression=lzma2
SolidCompression=yes
SetupIconFile=..\app\static\favicon.ico
UninstallDisplayIcon={app}\TraceLens.ico

[Files]
Source: "..\dist\TraceLens-PC\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\app\static\favicon.ico"; DestDir: "{app}"; DestName: "TraceLens.ico"; Flags: ignoreversion

[InstallDelete]
Type: files; Name: "{userprograms}\TraceLens PC Collector.lnk"
Type: files; Name: "{app}\TraceLens-PC.exe"
Type: files; Name: "{app}\START_PC_COLLECTOR.bat"
Type: files; Name: "{app}\local_collector\server.mjs"
Type: files; Name: "{app}\local_collector\attach.mjs"
Type: files; Name: "{app}\local_collector\bridge.mjs"
Type: files; Name: "{app}\local_collector\site_status.mjs"

[Icons]
Name: "{userprograms}\TraceLens"; Filename: "{app}\TraceLens.exe"; WorkingDir: "{app}"; IconFilename: "{app}\TraceLens.ico"

[Run]
Filename: "{app}\TraceLens.exe"; Description: "TraceLens PC Collector 실행"; WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent

[Code]
function InitializeSetup(): Boolean;
var
  InstalledPath, InstalledVersion: String;
  ExitCode, Index: Integer;
begin
  Result := True;
  for Index := 1 to ParamCount do
    if CompareText(ParamStr(Index), '/UPDATE') = 0 then Exit;
  if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\TraceLens.PCCollector_is1', 'InstallLocation', InstalledPath)
    and RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\TraceLens.PCCollector_is1', 'DisplayVersion', InstalledVersion)
    and (InstalledVersion = '{#TraceLensVersion}')
    and FileExists(AddBackslash(InstalledPath) + 'TraceLens.exe') then
  begin
    if Exec(AddBackslash(InstalledPath) + 'TraceLens.exe', '', InstalledPath, SW_SHOWNORMAL, ewNoWait, ExitCode) then
      Result := False;
  end;
end;
