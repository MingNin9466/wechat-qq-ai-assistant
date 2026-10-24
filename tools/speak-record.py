"""
从系统输出（WASAPI 回环）录音，自动判断"开始说话"和"说完了"。

用法：
  python tools/speak-record.py --out out.wav [--max 40] [--silence 1.2]
  python tools/speak-record.py --meter            # 只看电平，不录音

它录的是**扬声器正在播放的声音**，不需要虚拟声卡。
"""
from __future__ import annotations

import argparse
import sys
import time
import wave

import numpy as np
import pyaudiowpatch as pyaudio


def open_loopback(p: pyaudio.PyAudio):
    """拿到默认输出设备对应的回环设备"""
    wasapi = p.get_host_api_info_by_type(pyaudio.paWASAPI)
    spk = p.get_device_info_by_index(wasapi["defaultOutputDevice"])
    for dev in p.get_loopback_device_info_generator():
        if dev["name"].startswith(spk["name"]) or spk["name"] in dev["name"]:
            return dev
    # 退路：第一台回环设备
    for dev in p.get_loopback_device_info_generator():
        return dev
    raise RuntimeError("没有找到回环设备")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="")
    ap.add_argument("--max", type=float, default=40.0, help="最长录音秒数")
    ap.add_argument("--silence", type=float, default=1.2, help="静音多久算说完")
    ap.add_argument("--start-timeout", type=float, default=25.0, help="等多久还没声音就放弃")
    ap.add_argument("--meter", action="store_true", help="只打印电平")
    args = ap.parse_args()

    p = pyaudio.PyAudio()
    try:
        dev = open_loopback(p)
        rate = int(dev["defaultSampleRate"])
        ch = max(1, int(dev["maxInputChannels"]))
    except Exception as exc:  # noqa: BLE001
        print(f"打开回环设备失败: {exc}", file=sys.stderr)
        p.terminate()
        return 2

    frames: list[np.ndarray] = []
    state = {"speaking": False, "last_loud": 0.0, "started": 0.0, "peak": 0.0}

    def callback(in_data, frame_count, time_info, status):  # noqa: ANN001
        buf = np.frombuffer(in_data, dtype=np.float32)
        frames.append(buf.copy())
        if args.meter:
            rms = float(np.sqrt(np.mean(buf**2))) if buf.size else 0.0
            state["peak"] = max(state["peak"], rms)
        return (None, pyaudio.paContinue)

    stream = p.open(
        format=pyaudio.paFloat32,
        channels=ch,
        rate=rate,
        input=True,
        input_device_index=dev["index"],
        frames_per_buffer=1024,
        stream_callback=callback,
    )

    t0 = time.time()
    threshold = float(__import__("os").environ.get("SPEAK_RMS", "0.004"))
    try:
        stream.start_stream()
        while True:
            time.sleep(0.05)
            now = time.time()
            elapsed = now - t0
            if args.meter:
                if elapsed > args.max:
                    break
                continue
            if not frames:
                if elapsed > args.start_timeout:
                    print("超时：没有检测到声音", file=sys.stderr)
                    return 3
                continue
            recent = np.concatenate(frames[-3:]) if len(frames) >= 3 else frames[-1]
            rms = float(np.sqrt(np.mean(recent**2))) if recent.size else 0.0
            if rms > threshold:
                if not state["speaking"]:
                    state["speaking"] = True
                    state["started"] = now
                state["last_loud"] = now
            elif state["speaking"] and now - state["last_loud"] > args.silence:
                break
            if state["speaking"] and now - state["started"] > args.max:
                break
            if not state["speaking"] and elapsed > args.start_timeout:
                print("超时：没有检测到声音", file=sys.stderr)
                return 3
    finally:
        try:
            stream.stop_stream()
            stream.close()
        except Exception:  # noqa: BLE001
            pass
        p.terminate()

    if args.meter:
        print(f"峰值 RMS: {state['peak']:.4f}")
        return 0

    if not state["speaking"] or not frames:
        print("没有录到声音", file=sys.stderr)
        return 3

    pcm = np.concatenate(frames)
    # 掐掉开头静音
    n = len(pcm) // ch
    if n:
        mono = pcm[: n * ch].reshape(n, ch).mean(axis=1)
        idx = np.where(np.abs(mono) > threshold)[0]
        start = max(0, int(idx[0]) - int(rate * 0.25)) if idx.size else 0
        pcm = pcm[start * ch :]
    data = np.clip(pcm, -1.0, 1.0)
    int16 = (data * 32767).astype(np.int16)

    with wave.open(args.out, "wb") as wf:
        wf.setnchannels(ch)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(int16.tobytes())

    dur = len(int16) / ch / rate
    print(f"录到 {dur:.1f} 秒 → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
