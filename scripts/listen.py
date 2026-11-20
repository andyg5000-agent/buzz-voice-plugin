import base64, json, os, sys, time
import numpy as np
import sherpa_onnx

d, n = sys.argv[1], sys.argv[2]
silence = float(sys.argv[3]) if len(sys.argv) > 3 else 0.6
rate = 16000
w = os.path.join(d, f"sherpa-onnx-whisper-{n}", n)


def out(**msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


started = time.time()
recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
    encoder=f"{w}-encoder.int8.onnx",
    decoder=f"{w}-decoder.int8.onnx",
    tokens=f"{w}-tokens.txt",
    language="en",
    task="transcribe",
    num_threads=4,
)
config = sherpa_onnx.VadModelConfig()
config.silero_vad.model = os.path.join(d, "silero_vad.onnx")
config.silero_vad.threshold = 0.5
config.silero_vad.min_silence_duration = silence
config.silero_vad.min_speech_duration = 0.25
config.silero_vad.max_speech_duration = 30
config.sample_rate = rate
window = config.silero_vad.window_size
vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=120)
pending = np.zeros(0, dtype=np.float32)
speaking = False
parts = {}


def decode(samples):
    t = time.time()
    stream = recognizer.create_stream()
    stream.accept_waveform(rate, samples)
    recognizer.decode_stream(stream)
    return stream.result.text.strip(), int((time.time() - t) * 1000)


def pcm(data):
    return np.frombuffer(base64.b64decode(data), dtype="<i2").astype(np.float32) / 32768


out(ready=True, ms=int((time.time() - started) * 1000))
for line in sys.stdin:
    op, _, rest = line.strip().partition(" ")
    try:
        if op == "a":
            pending = np.concatenate([pending, pcm(rest)])
            while len(pending) >= window:
                vad.accept_waveform(pending[:window])
                pending = pending[window:]
                if vad.is_speech_detected() != speaking:
                    speaking = not speaking
                    out(speech=speaking)
                while not vad.empty():
                    samples = np.array(vad.front.samples, dtype=np.float32)
                    vad.pop()
                    text, ms = decode(samples)
                    out(text=text, ms=ms, seconds=round(len(samples) / rate, 2))
        elif op == "p":
            ref, _, data = rest.partition(" ")
            parts.setdefault(ref, []).append(pcm(data))
        elif op == "d":
            ref = rest
            chunks = parts.pop(ref, [])
            samples = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
            text, ms = decode(samples)
            out(id=ref, text=text, ms=ms)
        elif op == "r":
            vad.reset()
            pending = np.zeros(0, dtype=np.float32)
            if speaking:
                speaking = False
                out(speech=False)
    except Exception as error:
        if op == "d":
            out(id=rest, error=str(error))
        else:
            out(error=str(error))
