import sys, json, os
os.environ['GGML_CUDA_ENABLE'] = '0'
os.environ['CUDA_VISIBLE_DEVICES'] = '-1'

import gpt4all
print("GPT4All version:", gpt4all.__version__ if hasattr(gpt4all, "__version__") else "unknown")

from gpt4all import GPT4All as GPT4AllCls

model_path = 'C:/Users/Admin/Desktop/youtubeauto/models/mistral-7b-instruct-v0.1.Q4_0.gguf'
model_dir = 'C:/Users/Admin/Desktop/youtubeauto/models'

print("Loading model...")
model = GPT4AllCls(model_path, model_path=model_dir)
print("Model loaded OK")

prompt = 'Generate a JSON array of 3 scenes for a short video about dogs.'

print("Generating with all params...")
try:
    response = model.generate(prompt, max_tokens=4096, temp=0.95, top_k=60, top_p=0.97, repeat_penalty=1.15)
    print("RESPONSE length:", len(response))
    print("RESPONSE:", repr(response[:500]))
except Exception as e:
    print("ERROR with params:", e)
    
    print("Trying without repeat_penalty...")
    try:
        response = model.generate(prompt, max_tokens=4096, temp=0.95, top_k=60, top_p=0.97)
        print("RESPONSE length:", len(response))
        print("RESPONSE:", repr(response[:500]))
    except Exception as e2:
        print("ERROR without repeat_penalty:", e2)
        
        print("Trying simple default generate...")
        try:
            response = model.generate(prompt, max_tokens=100)
            print("RESPONSE length:", len(response))
            print("RESPONSE:", repr(response[:500]))
        except Exception as e3:
            print("ERROR simple:", e3)