import base64, glob, json, os, sys, time
import numpy as np
import sherpa_onnx

d = sys.argv[1]
model_name = sys.argv[2] if len(sys.argv) > 2 else "kokoro-en-v0_19"
model_dir = os.path.join(d, model_name)


def out(**msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


if not os.path.isdir(model_dir):
    out(error="no-model")
    sys.exit(0)

onnx_files = sorted(glob.glob(os.path.join(model_dir, "*.onnx")))
tokens = os.path.join(model_dir, "tokens.txt")
if not onnx_files or not os.path.isfile(tokens):
    out(error="no-model")
    sys.exit(0)

data_dir = os.path.join(model_dir, "espeak-ng-data")
if not os.path.isdir(data_dir):
    data_dir = ""

voices = os.path.join(model_dir, "voices.bin")
lexicon = os.path.join(model_dir, "lexicon.txt")
if not os.path.isfile(lexicon):
    lexicon = ""

started = time.time()
try:
    if os.path.isfile(voices):
        model_cfg = sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=onnx_files[0],
                voices=voices,
                tokens=tokens,
                data_dir=data_dir,
            ),
            num_threads=4,
            debug=False,
        )
    else:
        model_cfg = sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=onnx_files[0],
                lexicon=lexicon,
                tokens=tokens,
                data_dir=data_dir,
            ),
            num_threads=4,
            debug=False,
        )
    tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=model_cfg))
except Exception as err:
    out(error=str(err))
    sys.exit(1)

out(
    ready=True,
    rate=int(tts.sample_rate),
    speakers=int(getattr(tts, "num_speakers", 1)),
    ms=int((time.time() - started) * 1000),
)

for line in sys.stdin:
    raw = line.strip()
    if not raw:
        continue
    req_id = ""
    try:
        req = json.loads(raw)
        req_id = str(req.get("id", ""))
        text = str(req.get("text", "")).strip()
        sid = int(req.get("sid", 0))
        speed = float(req.get("speed", 1.0))
        if not text:
            out(id=req_id, rate=int(tts.sample_rate), pcm="", ms=0)
            continue
        t = time.time()
        audio = tts.generate(text, sid=sid, speed=max(0.5, min(2.0, speed)))
        samples = np.asarray(audio.samples, dtype=np.float32)
        pcm16 = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
        out(
            id=req_id,
            rate=int(audio.sample_rate),
            pcm=base64.b64encode(pcm16).decode("ascii"),
            ms=int((time.time() - t) * 1000),
        )
    except Exception as err:
        out(id=req_id, error=str(err))
