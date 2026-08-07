#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif
#ifndef ReleaseDir
  #define ReleaseDir "..\artifacts\release\KA-Asset-Batch"
#endif
#ifndef PrerequisiteDir
  #define PrerequisiteDir "..\artifacts\prerequisites"
#endif
#ifndef OutputDir
  #define OutputDir "..\artifacts\installer"
#endif

#define MyAppName "KA Asset Batch"
#define MyAppExeName "KA.PromptStudio.exe"
#define MyAppPublisher "KA"

[Setup]
AppId={{8A203E5B-7C41-4BA3-A3D9-E69B3109429E}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={code:GetDefaultInstallDir}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=KA-Asset-Batch-Setup-{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} 安装程序
VersionInfoProductName={#MyAppName}
SetupLogging=yes
ChangesAssociations=no

[Languages]
Name: "default"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: unchecked

[Files]
Source: "{#ReleaseDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PrerequisiteDir}\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: NeedWebView2

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "正在安装 Microsoft Edge WebView2 Runtime…"; Flags: waituntilterminated; Check: NeedWebView2
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebView2ClientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function GetDefaultInstallDir(Param: String): String;
begin
  if DirExists('D:\') then
    Result := 'D:\KA Asset Batch'
  else
    Result := ExpandConstant('{localappdata}\Programs\KA Asset Batch');
end;

function NeedWebView2: Boolean;
var
  Version: String;
begin
  Result := not (
    RegQueryStringValue(HKLM32, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId, 'pv', Version) or
    RegQueryStringValue(HKCU32, 'Software\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId, 'pv', Version)
  );
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  WorkspacePath: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    WorkspacePath := ExpandConstant('{app}\workspace');
    if DirExists(WorkspacePath) and (not UninstallSilent) and
       (MsgBox('是否同时删除所有项目、Cache、输出、队列和路由预设？' + #13#10 +
               '选择“否”会保留 workspace，便于以后重装或升级。',
               mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES) then
      DelTree(WorkspacePath, True, True, True);
  end;
end;
