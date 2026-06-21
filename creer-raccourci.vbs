' Double-clique sur ce fichier UNE FOIS pour creer un raccourci
' "MacheUp Studio" sur le Bureau, avec l'icone icon.ico.
' (Un .bat ne peut pas avoir sa propre icone personnalisee dans
' l'Explorateur Windows -- seul un raccourci .lnk le peut.)

Set WshShell = CreateObject("WScript.Shell")
strDesktop = WshShell.SpecialFolders("Desktop")

Set link = WshShell.CreateShortcut(strDesktop & "\MacheUp Studio.lnk")
link.TargetPath = "C:\studiomashup\start.bat"
link.WorkingDirectory = "C:\studiomashup"
link.IconLocation = "C:\studiomashup\icon.ico"
link.Description = "Lancer MacheUp Studio"
link.Save

MsgBox "Raccourci 'MacheUp Studio' cree sur le Bureau !", vbInformation, "MacheUp Studio"
