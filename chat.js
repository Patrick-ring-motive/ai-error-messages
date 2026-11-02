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
    if (!res.ok) {
      return completion(model, `${res.status} ${res.statusText} ${await res.text()}`);
    }
    return await res.json();
  } catch (e) {
    return completion(model, String(e));
  }
};
