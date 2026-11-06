d=${1:-$HOME/buzz-voice-models}
case $d in "~/"*) d=$HOME/${d#"~/"};; esac
n=${2:-small.en}
w=$d/sherpa-onnx-whisper-$n
b=$d/sherpa-onnx/bin/sherpa-onnx-offline
[ -x "$b" ] || b=$(command -v sherpa-onnx-offline) || { echo '{"error":"no-engine"}'; exit 0; }
[ -f "$w/$n-tokens.txt" ] || { echo '{"error":"no-model"}'; exit 0; }
f=$(mktemp "${TMPDIR:-/tmp}/buzz-voice.XXXXXX") || exit 1
trap 'rm -f "$f"' EXIT
openssl base64 -d -A > "$f" || exit 1
"$b" --whisper-encoder="$w/$n-encoder.int8.onnx" --whisper-decoder="$w/$n-decoder.int8.onnx" --tokens="$w/$n-tokens.txt" --whisper-language=en --whisper-task=transcribe --num-threads=4 "$f" | grep '^{'
