import sys,os,json,time,base64
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
payload=json.loads(sys.stdin.read())
sys.path.insert(0,payload['runtimePath'])
started=time.monotonic()
try:
 import torch
 from llama_cpp import Llama
 from llama_cpp.llama_multimodal import Qwen25VLChatHandler
 handler=Qwen25VLChatHandler(mmproj_path=payload['mmprojPath'],verbose=False,use_gpu=False)
 llm=Llama(model_path=payload['modelPath'],chat_handler=handler,n_gpu_layers=0,n_ctx=4096,n_threads=4,verbose=False)
 loaded=time.monotonic()
 content=[{'type':'text','text':payload['question']}]
 for image in payload['images']:
  content.extend([{'type':'text','text':'Image '+image['view']},{'type':'image_url','image_url':{'url':'data:image/jpeg;base64,'+image['base64']}}])
 result=llm.create_chat_completion(messages=[{'role':'user','content':content}],max_tokens=payload.get('maxTokens',512),temperature=0,**({'response_format':{'type':'json_object'}} if payload.get('jsonMode',False) else {}))
 llm.close()
 output={'status':'SUCCEEDED','text':result['choices'][0]['message']['content'],'device':'CPU','loadMs':round((loaded-started)*1000),'inferenceMs':round((time.monotonic()-loaded)*1000)}
except Exception as e:
 output={'status':'FAILED','errorName':type(e).__name__,'device':'CPU','totalMs':round((time.monotonic()-started)*1000)}
print('QA_RESULT:'+json.dumps(output))
