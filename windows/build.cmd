@echo off
rem Builds Beam.exe with the C# compiler that ships with .NET Framework 4.8 (no SDK needed).
rem Output: windows\bin\Beam.exe, copied to dist\Beam.exe, plus dist\Beam.exe.json with the version
rem (the server offers the update to installed apps once both exist). The version lives in src\Version.cs.
rem The WebView2 SDK in lib\webview2 (see its README) is embedded in the exe, so Beam.exe stays one file.
setlocal
set "HERE=%~dp0"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo .NET Framework 4.x C# compiler not found.
  exit /b 1
)
set "ICON=%HERE%..\scripts\beam.ico"
set "WV=%HERE%lib\webview2"
if not exist "%WV%\Microsoft.Web.WebView2.Core.dll" (
  echo The WebView2 SDK is missing from lib\webview2 ^(see lib\webview2\README.md^).
  exit /b 1
)
set "VER="
for /f tokens^=2^ delims^=^" %%a in ('findstr /c:"const string Text" "%HERE%src\Version.cs"') do set "VER=%%a"
if not defined VER (
  echo Could not read the version from src\Version.cs
  exit /b 1
)
if not exist "%HERE%bin" mkdir "%HERE%bin"

"%CSC%" /nologo /target:winexe /platform:anycpu /optimize+ /warn:4 /langversion:5 /codepage:65001 ^
  /out:"%HERE%bin\Beam.exe" ^
  /win32icon:"%ICON%" ^
  /win32manifest:"%HERE%app.manifest" ^
  /resource:"%ICON%",Beam.icon.ico ^
  /resource:"%WV%\Microsoft.Web.WebView2.Core.dll",Beam.webview2.Core.dll ^
  /resource:"%WV%\Microsoft.Web.WebView2.WinForms.dll",Beam.webview2.WinForms.dll ^
  /resource:"%WV%\x64\WebView2Loader.dll",Beam.webview2.x64.WebView2Loader.dll ^
  /resource:"%WV%\x86\WebView2Loader.dll",Beam.webview2.x86.WebView2Loader.dll ^
  /resource:"%WV%\arm64\WebView2Loader.dll",Beam.webview2.arm64.WebView2Loader.dll ^
  /resource:"%HERE%rc\rc-host.html",Beam.rc.rc-host.html ^
  /resource:"%HERE%rc\rc-host.js",Beam.rc.rc-host.js ^
  /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll ^
  /r:System.Net.Http.dll /r:System.Web.Extensions.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /r:System.Security.dll ^
  /r:"%WV%\Microsoft.Web.WebView2.Core.dll" /r:"%WV%\Microsoft.Web.WebView2.WinForms.dll" ^
  "%HERE%src\*.cs"
if errorlevel 1 (
  echo Build failed.
  exit /b 1
)

if not exist "%HERE%..\dist" mkdir "%HERE%..\dist"
copy /y "%HERE%bin\Beam.exe" "%HERE%..\dist\Beam.exe" >nul
if errorlevel 1 (
  echo Built bin\Beam.exe but could not copy it to dist\ ^(is Beam running?^)
  exit /b 1
)
> "%HERE%..\dist\Beam.exe.json" echo {"version":"%VER%"}
echo Built Beam %VER%: "%HERE%bin\Beam.exe", copied to dist\Beam.exe (+ dist\Beam.exe.json)
