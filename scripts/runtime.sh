d=${1:-$HOME/buzz-voice-models}
case $d in "~/"*) d=$HOME/${d#"~/"};; esac
p=$d/venv/bin/python3
v=$d/silero_vad.onnx
ok() { [ -x "$p" ] && [ -f "$v" ] && "$p" -I -c 'import sherpa_onnx, numpy' 2>/dev/null; }
if [ "$2" = install ] && ! ok; then
set -e; mkdir -p "$d"
command -v python3 >/dev/null || { echo '{"runtime":false,"error":"no-python"}'; exit 0; }
echo "progress runtime"
[ -x "$p" ] || python3 -m venv "$d/venv"
"$p" -m pip install -q --disable-pip-version-check sherpa-onnx==2.0.1 numpy >&2
[ -f "$v" ] || curl -fsSL -o "$v" https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx
set +e
fi
if ok; then echo '{"runtime":true}'; else echo '{"runtime":false}'; fi
