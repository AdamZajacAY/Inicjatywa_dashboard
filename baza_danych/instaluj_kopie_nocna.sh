#!/bin/bash
# Instaluje automatyczna nocna kopie bazy produkcyjnej (Render) na tym Macu.
# Uruchom RAZ w Terminalu:  bash baza_danych/instaluj_kopie_nocna.sh
# Wczesniej: w aplikacji (Uzytkownicy) zaloz konto z rola "Konto techniczne — tylko kopia bazy".
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/Library/Application Support/InicjatywaKopia"
OUT_DIR="$HOME/Kopie_Inicjatywa_produkcja"
PLIST="$HOME/Library/LaunchAgents/pl.inicjatywaprojektowa.kopia.plist"
SERVICE="ip-dashboard-kopia"

read -r -p "E-mail konta technicznego (rola 'Kopia'): " EMAIL
echo "Hasło zapisze się w pęku kluczy macOS (usługa '$SERVICE') — nie w żadnym pliku."
security add-generic-password -U -s "$SERVICE" -a "$EMAIL" -w
mkdir -p "$APP_DIR" "$OUT_DIR" "$HOME/Library/LaunchAgents"
# launchd zwykle nie ma dostepu do ~/Documents (ochrona prywatnosci macOS) - skrypt dziala z kopii
cp "$HERE/pobierz_backup_produkcji.py" "$APP_DIR/"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>pl.inicjatywaprojektowa.kopia</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/python3</string><string>$APP_DIR/pobierz_backup_produkcji.py</string>
    <string>--email</string><string>$EMAIL</string><string>--out</string><string>$OUT_DIR</string>
  </array>
  <!-- codziennie 21:30; jesli Mac spal, launchd uruchomi zadanie po wybudzeniu -->
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$OUT_DIR/kopia.log</string>
  <key>StandardErrorPath</key><string>$OUT_DIR/kopia.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Zainstalowano. Próbna kopia teraz:"
/usr/bin/python3 "$APP_DIR/pobierz_backup_produkcji.py" --email "$EMAIL" --out "$OUT_DIR"
echo "Gotowe — kopie co wieczór o 21:30 w $OUT_DIR (log: kopia.log). Usunięcie: launchctl bootout gui/\$(id -u) \"$PLIST\""
