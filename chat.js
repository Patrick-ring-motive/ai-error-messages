const unescapeFlat = (() => {
  const _ = [].join();
  const x = String.fromCharCode(92);
  const xx = x + x;
  const esc = {
    0: String.fromCharCode(0),
    a: String.fromCharCode(7),
    b: String.fromCharCode(8),
    t: String.fromCharCode(9),
    n: String.fromCharCode(10),
    v: String.fromCharCode(11),
    f: String.fromCharCode(12),
    r: String.fromCharCode(13)
  };
  esc[String.fromCharCode(34)] = String.fromCharCode(34);
  esc[String.fromCharCode(39)] = String.fromCharCode(39);
  Object.freeze(esc);
  return (txt) => {
    txt = String(txt ?? _);
    while (txt.includes(xx)) {
      txt = txt.replaceAll(xx, x);
    }
    for (const char in esc) {
      txt = txt.replaceAll(x + char, esc[char]).replaceAll(x + esc[char], esc[char]);
    }
    return txt.replaceAll(x, _);
  };
})();

const completion = (model, content, usage = {}) =>{
  content = unescapeFlat(String(content));
  return ({
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
})
};


const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Values from `over` win, except null, undefined, and "" never overwrite `base`.
const merge = (base, over) => {
  if (over == null || over === "") return base;
  if (Array.isArray(base) && Array.isArray(over)) {
    const out = [...base];
    over.forEach((v, i) => { out[i] = i in base ? merge(base[i], v) : v; });
    return out;
  }
  if (isObj(base) && isObj(over)) {
    const out = { ...base };
    for (const k of Object.keys(over)) {
      out[k] = k in base ? merge(base[k], over[k]) : over[k];
    }
    return out;
  }
  return over;
};

const hasContent = (d) =>
  typeof d?.choices?.[0]?.message?.content === "string" &&
  d.choices[0].message.content.length > 0;

const fetchCompletion = async (content, model) => {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
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

    const raw = await res.text();

    let data;
    try { data = JSON.parse(raw); } catch {}

    if (res.ok && hasContent(data)) return data;

    const wrapped = completion(model, res.ok ? raw : `${res.status}: ${raw}`);
    return isObj(data) ? merge(wrapped, data) : wrapped;
  } catch (e) {
    return completion(model, String(e));
  }
};
