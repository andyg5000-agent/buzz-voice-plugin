command -v say >/dev/null || exit 127
f=$(mktemp "${TMPDIR:-/tmp}/bv-say.XXXXXX") || exit 1
trap 'rm -f "$f"' EXIT
if [ -n "$1" ]; then
say -v "$1" -r "${2:-190}" -o "$f" --file-format=WAVE --data-format=LEI16@24000 -f - || exit 1
else
say -r "${2:-190}" -o "$f" --file-format=WAVE --data-format=LEI16@24000 -f - || exit 1
fi
openssl base64 -A < "$f"
