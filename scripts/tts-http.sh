u=$1; k=$2
f=$(mktemp "${TMPDIR:-/tmp}/bv-tts.XXXXXX") || exit 1
trap 'rm -f "$f"' EXIT
if [ -n "$k" ]; then
curl -fsS --max-time 60 -H "Content-Type: application/json" -H "Authorization: Bearer $k" --data-binary @- -o "$f" "$u" || exit 1
else
curl -fsS --max-time 60 -H "Content-Type: application/json" --data-binary @- -o "$f" "$u" || exit 1
fi
openssl base64 -A < "$f"
