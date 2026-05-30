import sys, json, os
os.environ['GGML_CUDA_ENABLE'] = '0'
os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
sys.stderr = open(os.devnull, 'w')

results = {}
try:
    from gpt4all import GPT4All
    results['gpt4all'] = True
except Exception:
    results['gpt4all'] = False

model_path = os.path.join(os.path.dirname(__file__), '..', 'models', 'mistral-7b-instruct-v0.1.Q4_0.gguf')
results['gpt4all_model'] = os.path.exists(model_path)

results['success'] = results.get('gpt4all', False)
print(json.dumps(results))
