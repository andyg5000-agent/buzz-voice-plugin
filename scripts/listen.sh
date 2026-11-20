d=${1:-$HOME/buzz-voice-models}
case $d in "~/"*) d=$HOME/${d#"~/"};; esac
p=$d/venv/bin/python3
[ -x "$p" ] || { echo '{"error":"no-runtime"}'; exit 0; }
exec "$p" -I -u -c "$4" "$d" "${2:-small.en}" "${3:-0.6}"
