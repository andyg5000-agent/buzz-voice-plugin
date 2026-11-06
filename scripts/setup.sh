d=${1:-$HOME/buzz-voice-models}
case $d in "~/"*) d=$HOME/${d#"~/"};; esac
n=${3:-small.en}
v=2.0.1
r=https://github.com/k2-fsa/sherpa-onnx/releases/download
e=false; if [ -x "$d/sherpa-onnx/bin/sherpa-onnx-offline" ] || command -v sherpa-onnx-offline >/dev/null; then e=true; fi
m=false; [ -f "$d/sherpa-onnx-whisper-$n/$n-tokens.txt" ] && m=true
if [ "$2" = install ]; then
set -e; mkdir -p "$d"; cd "$d"
case $(uname -s) in Darwin) p=osx-universal2;; *) p=linux-x64;; esac
if [ $e = false ]; then
echo "progress engine"
curl -fsSL "$r/v$v/sherpa-onnx-v$v-$p-shared-no-tts.tar.bz2" | tar xjf -
rm -rf sherpa-onnx; mv "sherpa-onnx-v$v-$p-shared-no-tts" sherpa-onnx; e=true
fi
if [ $m = false ]; then
echo "progress model"
curl -fsSL "$r/asr-models/sherpa-onnx-whisper-$n.tar.bz2" | tar xjf -; m=true
fi
fi
s=null; c="$HOME/Library/Application Support/com.blueoakinteractive.buzz-voice/settings.json"
[ -f "$c" ] && s=$(cat "$c")
printf '{"engine":%s,"model":%s,"buzzVoice":%s}\n' $e $m "$s"
