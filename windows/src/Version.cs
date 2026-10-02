// The app version, kept in one place. build.cmd reads it to write dist\Beam.exe.json.
using System.Reflection;

[assembly: AssemblyVersion(Beam.AppVersion.Text + ".0")]
[assembly: AssemblyFileVersion(Beam.AppVersion.Text + ".0")]
[assembly: AssemblyInformationalVersion(Beam.AppVersion.Text)]

namespace Beam
{
    static class AppVersion
    {
        public const string Text = "1.7.2";
    }
}
