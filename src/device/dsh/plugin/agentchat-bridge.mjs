// AgentChat's plugin for DeepSeek Harness (host side, loaded by DSH's own plugin loader from the desktop profile's
// cordis.patch.yml). It lets messages from the phone and from other agents go into a DSH conversation the way the
// DSH window's own Send does: through DSH's session controller, inside the DSH process, so the window shows the turn
// at once and runs it. It only talks to AgentChat on this computer (127.0.0.1), with the token AgentChat leaves in
// the connection file; it asks there for the next message, sends it, and says how it went. No AgentChat running:
// it waits and asks again. Nothing else in DSH is touched.
import { readFile } from 'node:fs/promises';

export const name = 'agentchat-bridge';
export const inject = ['sessionController'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The loopback address and token AgentChat wrote (read each time: AgentChat may restart with a new one). */
async function connection(file) {
  const c = JSON.parse(await readFile(file, 'utf8'));
  const url = new URL(String(c.url));
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('AgentChat 的地址必须在本机');
  return { url: url.origin, token: String(c.token) };
}

async function call(c, op, body, timeoutMs) {
  const r = await fetch(`${c.url}/api/dsh-bridge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-allinone': '1' },
    body: JSON.stringify({ op, token: c.token, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`AgentChat ${r.status}`);
  return r.json();
}

/** One message into its conversation, as the window's Send would: queued after a running turn, or starting one. */
async function deliver(ctx, job) {
  try {
    const value = await ctx.sessionController.prompt({
      requestId: job.id,
      sessionId: job.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: job.text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, AbortSignal.timeout(60_000));
    if (value && value.ok === false) return { ok: false, error: String(value.error?.message ?? value.error?.code ?? 'refused') };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 300) };
  }
}

export function apply(ctx, config = {}) {
  const file = config.connectionFile;
  let stopped = false;
  ctx.effect(() => {
    void (async () => {
      while (!stopped) {
        let c;
        try {
          c = await connection(file);
          // Waits up to 25 s there for a message; nothing came: ask again.
          const job = await call(c, 'next', { wait: 25 }, 35_000);
          if (!job?.id) continue;
          await call(c, 'done', { id: job.id, ...(await deliver(ctx, job)) }, 15_000);
        } catch {
          // AgentChat not running (or restarting): look again a little later.
          if (!stopped) await sleep(5_000);
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, 'agentchat-bridge: deliveries');
}
