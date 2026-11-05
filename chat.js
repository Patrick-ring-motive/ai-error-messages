const randomId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return String(Math.random());
  }
};

const unescapeFlat = (() => {
  const _ = [].join();
  const x = String.fromCharCode(92);
  const xx = x + x;
  const hexDigit = "[0-9a-fA-F]";
  const u4 = new RegExp(xx + "u(" + hexDigit + "{4})", "g");
  const x2 = new RegExp(xx + "x(" + hexDigit + "{2})", "g");
  const hex = (_m, h) => String.fromCharCode(parseInt(h, 16));
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
  Object.assign(esc, {
    [String.fromCharCode(34)]: String.fromCharCode(34),
    [String.fromCharCode(39)]: String.fromCharCode(39)
  });
  Object.freeze(esc);
  const escapes = Object.entries(esc);
  return (txt) => {
    txt = String(txt ?? _);
    while (txt.includes(xx)) {
      txt = txt.replaceAll(xx, x);
    }
    txt = txt.replace(u4, hex).replace(x2, hex);
    for (const [char, value] of escapes) {
      txt = txt.replaceAll(x + char, value).replaceAll(x + value, value);
    }
    return txt.replaceAll(x, _);
  };
})();

const completion = (model, content, usage) => {
  usage = Object(usage);
  content = unescapeFlat(String(content));
  return ({
    id: `chatcmpl-${randomId()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content,
        refusal: null
      },
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
    for (const i of Array(over.length).keys()) {
      // Preserve forEach's behavior of skipping sparse array holes.
      if (!(i in over)) continue;
      const v = over[i];
      out[i] = i in base ? merge(base[i], v) : v;
    }
    return out;
  }
  if (isObj(base) && isObj(over)) {
    const out = {
      ...base
    };
    for (const k of Object.keys(over)) {
      out[k] = k in base ? merge(base[k], over[k]) : over[k];
    }
    return out;
  }
  return over;
};

const hasContent = (d) =>
  !!d?.choices?.[0]?.message?.content?.length > 0;

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
        messages: [{
          role: "user",
          content
        }],
      }),
    });

    const raw = await res.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch {}

    if (res.ok && hasContent(data)) return data;

    const wrapped = completion(model, res.ok ? raw : `${res.status}: ${raw}`);
    return isObj(data) ? merge(wrapped, data) : wrapped;
  } catch (e) {
    return completion(model, String(e));
  }
};

////stream

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const encoder = new TextEncoder();
const frame = (chunk) => encoder.encode("data: " + JSON.stringify(chunk) + NL + NL);
const DONE = encoder.encode("data: [DONE]" + NL + NL);
const asSSE = (value) => value.split(NL).map((line) => "data: " + line).join(NL) + NL + NL;
const FIELD = /^(:|event:|id:|retry:)/;

const payloadOf = (event) => {
  const lines = event.split(NL);
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  if (dataLines.length) {
    return dataLines.map((line) => line.slice(5).replace(/^ /, "")).join(NL);
  }
  return lines.every((line) => line === "" || FIELD.test(line)) ? "" : event;
};

const usable = (parsed) => {
  if (!isObj(parsed) || !Array.isArray(parsed.choices)) return false;
  if (parsed.choices.length === 0) return isObj(parsed.usage);
  const firstChoice = parsed.choices[0];
  return isObj(firstChoice) &&
    (isObj(firstChoice.delta) || isObj(firstChoice.message) || firstChoice.finish_reason != null);
};

const conformSSE = (model) => {
  const decoder = new TextDecoder();
  const state = {
    id: `chatcmpl-${randomId()}`,
    model,
    created: Math.floor(Date.now() / 1000),
    locked: false,
    buffer: "",
    raw: "",
    roleSent: false,
    contentSeen: false,
    doneSeen: false,
    held: null,
  };

  const baseChunk = (delta, finishReason = null) => ({
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{
      index: 0,
      delta,
      logprobs: null,
      finish_reason: finishReason
    }],
  });

  const send = (controller, chunk) =>
    state.held ? state.held.push(chunk) : controller.enqueue(frame(chunk));

  const emitText = (controller, value, extra = {}) => {
    state.locked = true;
    const delta = {
      content: unescapeFlat(value)
    };
    if (!state.roleSent) {
      delta.role = "assistant";
      state.roleSent = true;
    }
    state.contentSeen = true;
    send(controller, {
      ...extra,
      ...baseChunk(delta)
    });
  };

  const normalize = (controller, upstream) => {
    if (!state.locked) {
      if (typeof upstream.id === "string") state.id = upstream.id;
      if (typeof upstream.model === "string") state.model = upstream.model;
      if (Number.isInteger(upstream.created)) state.created = upstream.created;
      state.locked = true;
    }
    const output = {
      ...upstream,
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
    };
    if (upstream.choices.length) {
      const choice = {
        ...upstream.choices[0]
      };
      const delta = {
        ...(isObj(choice.delta) ? choice.delta : isObj(choice.message) ? choice.message : {}),
      };
      delete choice.message;
      if (delta.role) {
        state.roleSent = true;
      } else if (!state.roleSent) {
        delta.role = "assistant";
        state.roleSent = true;
      }
      if (
        (typeof delta.content === "string" && delta.content.length) ||
        delta.tool_calls?.length ||
        delta.function_call
      ) {
        state.contentSeen = true;
      }
      Object.assign(choice, {
        index: 0,
        delta
      });
      choice.logprobs ??= null;
      choice.finish_reason ??= null;
      output.choices = [choice, ...upstream.choices.slice(1)];
      if (choice.finish_reason !== null) state.held ??= [];
    }
    send(controller, output);
  };

  const handle = (controller, event) => {
    const payload = payloadOf(event);
    if (payload === "") return;
    if (payload.trim() === "[DONE]") {
      state.doneSeen = true;
      return;
    }
    if (state.raw.length < 65536) state.raw += payload + NL;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {}
    if (usable(parsed)) normalize(controller, parsed);
    else emitText(controller, payload, isObj(parsed) ? parsed : {});
  };

  const feed = (controller, incoming) => {
    state.buffer += incoming.replaceAll(CR, "");
    const events = state.buffer.split(NL + NL);
    state.buffer = events.pop();
    for (const event of events) {
      handle(controller, event);
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      feed(controller, decoder.decode(chunk, {
        stream: true
      }));
    },
    flush(controller) {
      feed(controller, decoder.decode());
      if (state.buffer.trim()) handle(controller, state.buffer);
      const held = state.held;
      state.held = null;
      if (!state.contentSeen) emitText(controller, state.raw || "[empty stream]");
      if (held) {
        for (const chunk of held) {
          controller.enqueue(frame(chunk));
        }
      } else {
        controller.enqueue(frame(baseChunk({}, state.doneSeen ? "stop" : "length")));
      }
      controller.enqueue(DONE);
    },
  });
};

const respond = (body) =>
  new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache"
    },
  });

const streamCompletion = async (content, model) => {
  const failed = (message) =>
    respond(new Response(asSSE(message)).body.pipeThrough(conformSSE(model)));
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{
          role: "user",
          content
        }]
      }),
    });
    if (!res.ok || !res.body) return failed(`${res.status}: ${await res.text()}`);
    return respond(res.body.pipeThrough(conformSSE(model)));
  } catch (error) {
    return failed(String(error));
  }
};
