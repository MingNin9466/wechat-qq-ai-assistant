import sys, time, json, os, traceback
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from faster_whisper import WhisperModel
model_dir = os.path.expanduser(r"~\.dsh\bili-humanism\media-runtime\faster-whisper-small")
audio = r"C:\Users\你的名字\微信群聊deepseek\data\tmp\neuro_audio.wav"

def run(device, compute):
    t0 = time.time()
    m = WhisperModel(model_dir, device=device, compute_type=compute)
    segs, info = m.transcribe(audio, language="zh", vad_filter=True, beam_size=5)
    out = [{"start": round(s.start,1), "end": round(s.end,1), "text": s.text.strip()} for s in segs]
    return out, info.duration, time.time()-t0, device

for device, compute in (("cuda", "float16"), ("cuda", "int8_float16"), ("cpu", "int8")):
    try:
        out, dur, secs, dev = run(device, compute)
        print(f"✔ 成功 device={dev} 耗时 {secs:.1f}s 段数 {len(out)} 时长 {dur:.0f}s")
        p = r"C:\Users\你的名字\微信群聊deepseek\data\tmp\neuro_asr.json"
        json.dump(out, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        full = " ".join(x["text"] for x in out)
        print("总字数:", len(full))
        print("--- 开头 350 字 ---")
        print(full[:350])
        break
    except Exception as e:
        print(f"✖ device={device}/{compute}: {type(e).__name__} {str(e)[:120]}")
