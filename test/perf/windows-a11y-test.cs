// Beam for Windows 1.19.3: what the hand-painted controls (Theme.cs) tell Windows' accessibility (Narrator, UI
// Automation): a role, a name, a check box's state and note, and a default action that does what a click does. Run by
// windows-a11y-test.mjs, which compiles this file with windows\src\Theme.cs and Util.cs. The controls are created and
// asked; no window is shown and nothing is clicked or typed.
using System;
using System.Windows.Forms;

namespace Beam
{
    static class A11yTest
    {
        static int failures, passed;

        static void Check(bool ok, string what)
        {
            if (ok) passed++; else failures++;
            Console.WriteLine((ok ? "ok   " : "FAIL ") + what);
        }

        [STAThread]
        static int Main()
        {
            var approve = new FlatButton("Approve", null);
            int clicks = 0;
            approve.Click += (s, e) => clicks++;
            var a = approve.AccessibilityObject;
            Check(a.Role == AccessibleRole.PushButton && a.Name == "Approve", "a button: a push button named by its text (" + a.Role + ", " + a.Name + ")");
            Check(a.DefaultAction == "Press", "its default action: Press");
            a.DoDefaultAction();
            Check(clicks == 1, "which clicks it");
            approve.Enabled = false;
            approve.AccessibilityObject.DoDefaultAction();
            Check(clicks == 1, "not while it's turned off");

            var close = new FlatButton("", Ui.GCheck);
            close.Tooltip = "Close";
            Check(close.AccessibilityObject.Name == "Close", "a glyph-only button: named by its tooltip (" + close.AccessibilityObject.Name + ")");
            close.AccessibleName = "Close this window";
            Check(close.AccessibilityObject.Name == "Close this window", "an AccessibleName set in code wins");

            var allow = new FlatCheck("Allow remote control");
            allow.Note = "Your devices can see and control this PC.";
            var c = allow.AccessibilityObject;
            Check(c.Role == AccessibleRole.CheckButton && c.Name == "Allow remote control", "a check box: its role and text (" + c.Role + ", " + c.Name + ")");
            Check(c.Description == "Your devices can see and control this PC.", "its note as the description");
            Check((c.State & AccessibleStates.Checked) == 0 && c.DefaultAction == "Check", "not ticked: Check");
            c.DoDefaultAction();
            Check(allow.Checked && (c.State & AccessibleStates.Checked) != 0 && c.DefaultAction == "Uncheck", "its default action ticks it, and it says so");

            Console.WriteLine(failures == 0 ? "All " + passed + " checks passed." : failures + " of " + (passed + failures) + " checks failed.");
            return failures == 0 ? 0 : 1;
        }
    }
}
