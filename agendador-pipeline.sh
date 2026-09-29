#!/data/data/com.termux/files/usr/bin/bash

BASE="$HOME/shopee-grupos-automacao"
LOG="$BASE/agendador.log"
MARCADOR="$BASE/.ultima-execucao"

cd "$BASE" || exit 1

HORA="$(date '+%H')"
DATA_HORA="$(date '+%Y-%m-%d-%H')"

# Horários oficiais do pipeline
case "$HORA" in
  06|08|12|16|20|22)
    ;;
  *)
    exit 0
    ;;
esac

# Impede duas execuções no mesmo horário
if [ -f "$MARCADOR" ] && [ "$(cat "$MARCADOR" 2>/dev/null)" = "$DATA_HORA" ]; then
  exit 0
fi

# Impede dois pipelines simultâneos
LOCK="$BASE/.pipeline-lock"

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pipeline anterior ainda em execução. Ignorando." >> "$LOG"
  exit 0
fi

trap 'rmdir "$LOCK" 2>/dev/null' EXIT

echo "$DATA_HORA" > "$MARCADOR"

echo "==================================================" >> "$LOG"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] INICIANDO PIPELINE AGENDADO" >> "$LOG"
echo "==================================================" >> "$LOG"

export BROWSER_EXECUTABLE_PATH="$PREFIX/bin/chromium-browser"
export CHROMIUM_PATH="$PREFIX/bin/chromium-browser"
export PLAYWRIGHT_BROWSERS_PATH=0
export BROWSER_HEADLESS=true
export PUBLICADOR=navegador
export MODO_PUBLICACAO_BROWSER=publicar
export BROWSER_INTERVALO_MS=5000

npm run pipeline >> "$LOG" 2>&1

STATUS=$?

echo "[$(date '+%Y-%m-%d %H:%M:%S')] PIPELINE FINALIZADO — código: $STATUS" >> "$LOG"

exit $STATUS
