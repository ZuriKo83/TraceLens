[Setup]
AppId=TraceLens.PCCollector
AppName=TraceLens PC Collector
AppVersion=0.1.0
AppPublisher=TraceLens
DefaultDirName={localappdata}\Programs\TraceLens PC Collector
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=TraceLens-PC-Setup
Compression=lzma2
SolidCompression=yes
SetupIconFile=..\app\static\favicon.ico
UninstallDisplayIcon={app}\TraceLens.ico

[Files]
Source: "..\dist\TraceLens-PC\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\app\static\favicon.ico"; DestDir: "{app}"; DestName: "TraceLens.ico"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\TraceLens PC Collector"; Filename: "{app}\TraceLens-PC.exe"; WorkingDir: "{app}"; IconFilename: "{app}\TraceLens.ico"

[Run]
Filename: "{app}\TraceLens-PC.exe"; Description: "TraceLens PC Collector 실행"; WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent
