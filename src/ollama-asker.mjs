// A local, free stand-in for the TypeSafe/Jev API that fast-jev-compaction
// normally calls. Implements the same `{ ask(state, questions) }` contract,
// but scores each question with a model running in Ollama instead of
// api.typesafe.ai, so no API key and no per-request cost are involved.

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen2.5:14b-instruct';
// Ollama's own default window is 4096 tokens, which silently cuts a bigger prompt from the front.
const DEFAULT_NUM_CTX = 16384;
// keeps the model loaded between the requests of one compaction (and a little after)
const DEFAULT_KEEP_ALIVE = '15m';
// output budget per question, so a rambling model can't run past the sandbox's 30 s request limit
const OUTPUT_TOKENS_PER_QUESTION = 20;

const SYSTEM_PROMPT = `You are a strict, literal-minded classifier deciding what to keep in a coding \
assistant's conversation history so it can be safely trimmed to save space. You will receive a \
JSON object with "state" (the conversation so far: a "goal" describing the current task and a \
"history" of turns, where tool outputs have already been removed and replaced with a short note) \
and "questions" (a map of question id to an instruction describing something to judge about one \
tool call). For every question id, decide the probability, from 0 (definitely no) to 1 \
(definitely yes), that the instruction is true. Judge only from the given state: would removing \
this call, or its result, plausibly cause the assistant to redo work, contradict a constraint the \
user gave, lose a file path, error message, or decision that matters later. Prefer keeping \
anything that looks like it could still matter; only score low when a call is clearly superseded, \
redundant, or safely re-derivable. Respond with ONLY a JSON object of the exact shape \
{"answers": {"<id>": {"noul": <number 0..1>}, ...}} with one entry per question id you were given \
and no other keys or text.`;

function answersSchema(questionIds) {
  const properties = {};
  for (const id of questionIds) {
    properties[id] = {
      type: 'object',
      properties: { noul: { type: 'number', minimum: 0, maximum: 1 } },
      required: ['noul'],
    };
  }
  return {
    type: 'object',
    properties: { answers: { type: 'object', properties, required: questionIds } },
    required: ['answers'],
  };
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('no JSON object in model output');
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Builds a JevAsker backed by a local Ollama server. `fetchFn` defaults to
 * the global fetch; override it in tests.
 */
export function ollamaAsker(config = {}) {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const model = config.model ?? DEFAULT_MODEL;
  const fetchFn = config.fetch ?? fetch;
  const numCtx = config.numCtx ?? DEFAULT_NUM_CTX;
  const keepAlive = config.keepAlive ?? DEFAULT_KEEP_ALIVE;

  return {
    // Loads the model without answering anything, so the first real request isn't also a cold load.
    async warm() {
      const response = await fetchFn(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: keepAlive }),
      });
      if (!response.ok) throw new Error(`Ollama warm-up failed (${response.status})`);
    },

    async ask(state, questions) {
      const questionIds = Object.keys(questions);
      // the model answers under short keys (q1, q2, ...): the real ids are long, and every
      // output token costs time against the request limit
      const aliases = questionIds.map((_, index) => `q${index + 1}`);
      const aliased = Object.fromEntries(questionIds.map((id, index) => [aliases[index], questions[id]]));
      const userPayload = JSON.stringify({ state, questions: aliased });

      const response = await fetchFn(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          keep_alive: keepAlive,
          options: {
            temperature: 0,
            num_ctx: numCtx,
            num_predict: aliases.length * OUTPUT_TOKENS_PER_QUESTION + 80,
          },
          format: answersSchema(aliases),
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPayload },
          ],
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Ollama request failed (${response.status}): ${text.slice(0, 200)}`);
      }

      const body = await response.json();
      const content = body?.message?.content;
      if (typeof content !== 'string' || content.length === 0) {
        throw new Error('Ollama returned no message content');
      }

      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        parsed = extractJson(content);
      }

      const answers = parsed?.answers;
      if (!answers || typeof answers !== 'object') {
        throw new Error('local model response is missing answers');
      }
      const byId = {};
      questionIds.forEach((id, index) => {
        const noul = answers[aliases[index]]?.noul;
        if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) {
          throw new Error(`local model gave no valid answer for ${id}`);
        }
        byId[id] = { noul };
      });
      return { model, answers: byId };
    },
  };
}
