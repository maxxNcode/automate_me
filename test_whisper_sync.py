"""Test whisper word-level timestamps against Edge TTS audio to diagnose sync issues."""
import asyncio
import subprocess
import os
import sys
import re
import gc

# Generate Edge TTS audio
script = "Did you know that octopuses have three hearts and blue blood. These incredible creatures can change color in an instant to blend into their surroundings."
print(f"SCRIPT: {script}")
print()

async def gen_tts():
    import edge_tts
    communicate = edge_tts.Communicate(script, "en-US-JennyNeural")
    await communicate.save(r"C:\Windows\TEMP\test_sync.mp3")

asyncio.run(gen_tts())

# Convert to WAV
ffmpeg = r"C:\Users\Admin\Desktop\youtubeauto\ffmpeg_bin\ffmpeg.exe"
subprocess.run([
    ffmpeg, "-y", "-i", r"C:\Windows\TEMP\test_sync.mp3",
    "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "1",
    r"C:\Windows\TEMP\test_sync.wav"
], capture_output=True, timeout=30)

# Get duration
result = subprocess.run([
    r"C:\Users\Admin\Desktop\youtubeauto\ffmpeg_bin\ffprobe.exe",
    "-v", "quiet", "-print_format", "json", "-show_format",
    r"C:\Windows\TEMP\test_sync.wav"
], capture_output=True, text=True, timeout=10)
import json
duration = float(json.loads(result.stdout)["format"]["duration"])
print(f"Audio duration: {duration:.2f}s")
print()

# Run whisper
from faster_whisper import WhisperModel
gc.collect()
model = WhisperModel("base", device="cuda", compute_type="float16")
segments, info = model.transcribe(r"C:\Windows\TEMP\test_sync.wav", beam_size=1, word_timestamps=True)
print(f"Whisper lang={info.language} prob={info.language_probability:.2f}")
whisper_words = []
for seg in segments:
    for w in seg.words:
        ww = w.word.strip()
        if ww:
            whisper_words.append(ww)
            print(f"  {w.start:.2f}s-{w.end:.2f}s: \"{ww}\"")
print(f"\nTotal whisper words: {len(whisper_words)}")

# Compare
def clean(w):
    return re.sub(r"[^\w']", "", w).lower()

script_words = [w for w in re.sub(r"[^\w\s]", "", script).split() if w]
print(f"\nScript words ({len(script_words)}): {script_words}")
print(f"Whisper words ({len(whisper_words)}): {whisper_words}")

# Simulate the alignment from _generate_scene_ass
aligned = []
match_count = 0
wi = 0
for idx, sw in enumerate(script_words):
    sw_clean = clean(sw)
    t_fallback = duration * idx / len(script_words)
    if not sw_clean:
        aligned.append({"start": t_fallback, "end": t_fallback + 0.3})
        continue
    found = False
    while wi < len(whisper_words):
        ww_clean = clean(whisper_words[wi])
        if sw_clean == ww_clean or (len(sw_clean) > 2 and (sw_clean in ww_clean or ww_clean in sw_clean)):
            aligned.append({"start": 0, "end": 0})  # placeholder
            wi += 1
            match_count += 1
            found = True
            break
        wi += 1
    if not found:
        pass  # would get fallback timing

print(f"\nMatched: {match_count}/{len(script_words)} = {match_count/len(script_words)*100:.0f}%")
if match_count < len(script_words) * 0.5:
    print("*** WOULD FALL BACK TO UNIFORM TIMING ***")
else:
    print("OK - using whisper timestamps")

del model
gc.collect()
print("\nDone")
