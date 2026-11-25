d=${1:-$HOME/buzz-voice-models}
case $d in "~/"*) d=$HOME/${d#"~/"};; esac
m=${3:-kokoro-en-v0_19}
r=https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models
has() { [ -d "$d/$m" ] && ls "$d/$m"/*.onnx >/dev/null 2>&1 && [ -f "$d/$m/tokens.txt" ]; }
if [ "$2" = install ] && ! has; then
set -e; mkdir -p "$d"; cd "$d"
echo "progress tts-model"
curl -fsSL "$r/$m.tar.bz2" | tar xjf -
set +e
fi
if has; then echo '{"ttsModel":true}'; else echo '{"ttsModel":false}'; fi
