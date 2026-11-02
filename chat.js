const completion = (model, content, usage = {}) => ({
  id: `chatcmpl-${crypto.randomUUID()}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{
    index: 0,
    message: { role: "assistant", content, refusal: null },
    logprobs: null,
    finish_reason: "stop",
  }],
  usage: {
    prompt_tokens: usage.prompt ?? 0,
    completion_tokens: usage.completion ?? 0,
    total_tokens: (usage.prompt ?? 0) + (usage.completion ?? 0),
  },
});

const fetchCompletion = async(text,model){
let res;
  try{
 res = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
  },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content }],
  }),
});
   if(!res.ok){
     return completion(model,res.statusText);
   }
    const data = await res.json();
  }catch(e){
    return completion(model,String(e));
  }
  return data;
}
