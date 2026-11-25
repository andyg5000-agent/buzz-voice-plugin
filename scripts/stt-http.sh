u=$1; m=${2:-whisper-1}; k=$3
f=$(mktemp "${TMPDIR:-/tmp}/bv-stt.XXXXXX") || exit 1
trap 'rm -f "$f"' EXIT
openssl base64 -d -A > "$f" || exit 1
if [ -n "$k" ]; then
curl -fsS --max-time 60 -H "Authorization: Bearer $k" -F "file=@$f;filename=audio.wav;type=audio/wav" -F "model=$m" "$u"
else
curl -fsS --max-time 60 -F "file=@$f;filename=audio.wav;type=audio/wav" -F "model=$m" "$u"
fi
