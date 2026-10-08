#!/data/data/com.termux/files/usr/bin/bash
# Pipeline agendado — horários: 06, 08, 12, 16, 20, 22
# Job 1002 via termux-job-scheduler. Preferir period-ms=300000 (5 min).

BASE="$HOME/shopee-grupos-automacao"
LOG="$BASE/agendador.log"
MARCADOR="$BASE/.ultima-execucao"
LOCK="$BASE/.pipeline-lock"

cd "$BASE" || exit 1

HORA="$(date '+%H')"
DATA_HORA="$(date '+%Y-%m-%d-%H')"
TS="$(date '+%Y-%m-%d %H:%M:%S')"

case "$HORA" in
  06|08|12|16|20|22)
    ;;
  *)
    if [ "${AGENDADOR_LOG_SKIP:-0}" = "1" ]; then
      echo "[$TS] Fora da janela (hora=$HORA). Saindo." >> "$LOG"
    fi
    exit 0
    ;;
esac

if [ -f "$MARCADOR" ] && [ "$(cat "$MARCADOR" 2>/dev/null)" = "$DATA_HORA" ]; then
  echo "[$TS] Já executado nesta janela ($DATA_HORA). Saindo." >> "$LOG"
  exit 0
fi

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "[$TS] Pipeline anterior ainda em execução. Ignorando." >> "$LOG"
  exit 0
fi

trap 'rmdir "$LOCK" 2>/dev/null' EXIT

echo "$DATA_HORA" > "$MARCADOR"

echo "==================================================" >> "$LOG"
echo "[$TS] INICIANDO PIPELINE AGENDADO (janela=$DATA_HORA)" >> "$LOG"
echo "==================================================" >> "$LOG"

export BROWSER_EXECUTABLE_PATH="${BROWSER_EXECUTABLE_PATH:-$PREFIX/bin/chromium-browser}"
export CHROMIUM_PATH="${CHROMIUM_PATH:-$PREFIX/bin/chromium-browser}"
export PLAYWRIGHT_BROWSERS_PATH=0
export BROWSER_HEADLESS="${BROWSER_HEADLESS:-true}"
export PUBLICADOR="${PUBLICADOR:-navegador}"
export MODO_PUBLICACAO_BROWSER="${MODO_PUBLICACAO_BROWSER:-publicar}"
export BROWSER_INTERVALO_MS="${BROWSER_INTERVALO_MS:-5000}"
export FORCAR_CDP="${FORCAR_CDP:-true}"
export CDP_HOST="${CDP_HOST:-127.0.0.1}"
export CDP_PORT="${CDP_PORT:-9222}"

npm run pipeline >> "$LOG" 2>&1
STATUS=$?

echo "[$(date '+%Y-%m-%d %H:%M:%S')] PIPELINE FINALIZADO — código: $STATUS" >> "$LOG"

exit $STATUS
