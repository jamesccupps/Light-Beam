# WebView2 SDK (vendored)

The Windows app's messenger window hosts the web UI in Microsoft Edge WebView2. These files come from Microsoft's
official NuGet package, kept here so `windows\build.cmd` works offline with the built-in C# compiler.

- Package: `Microsoft.Web.WebView2` **1.0.4258.31**, downloaded 2026-09-30 from
  `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4258.31/microsoft.web.webview2.1.0.4258.31.nupkg`
- nupkg SHA-512 matched the nuget.org catalog entry:
  `HlGVwvyP/IWiXAU8K57Vmg59khY3DWMOxMnH4AHusFRy0/vDAjKItXUIVNXiXXaq4CLfSZyNUic1wOIlnPLsPQ==`
- Every DLL has a valid Authenticode signature from Microsoft Corporation.
- License: `LICENSE.txt` (BSD-style, redistribution allowed with the notice).

| File | From the package | SHA-256 |
|---|---|---|
| `Microsoft.Web.WebView2.Core.dll` | `lib/net462/` | `d60e6e94245078cb56e44ebd5f360dc04bf18e460136be93bfc4cfca43b98505` |
| `Microsoft.Web.WebView2.WinForms.dll` | `lib/net462/` | `6a9e6856f23c463783c3afb0ca5d78f56324c86657162ccb16d5227b3233b32a` |
| `x64/WebView2Loader.dll` | `runtimes/win-x64/native/` | `3426dcc55fdfb8b5e7ac623cf33b4ccf283fbf68a0c5a65bddfdb4d749a8abee` |
| `x86/WebView2Loader.dll` | `runtimes/win-x86/native/` | `87c61e2cae380112c60853e28178b8ea9a0d63739fc03cead680d4ad3fde6b7d` |
| `arm64/WebView2Loader.dll` | `runtimes/win-arm64/native/` | `4f48cb32d34298c86cca2108057eea0d900b5e422575e926e8086318a0b9cbf0` |

The WebView2 **Runtime** itself is part of Windows 11 (and of Edge on Windows 10), so it isn't shipped with Beam.
To update the SDK, download a newer package the same way and verify its hash and signatures before replacing these files.
