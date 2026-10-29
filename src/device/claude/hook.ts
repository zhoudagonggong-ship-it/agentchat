// Claude Code hook (PermissionRequest, and PreToolUse for AskUserQuestion), installed by the Claude adapter.
// Hands the request to this computer's AllinOne, which may show it on the phone and wait for the answer.
// Prints the decision Claude Code should take, or nothing: then Claude Code asks on the computer as usual.
// Never fails the tool call: any error (AllinOne not running, say) also prints nothing.
import { CONTROL_PORT } from '../../shared/protocol.ts';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/api/claude-hook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-allinone': '1' }, body: input,
    });
    // AllinOne sends the headers at once and the answer when the phone (or the computer) gave it.
    const out = (await res.json()) as { output?: unknown };
    if (res.ok && out.output) process.stdout.write(JSON.stringify(out.output));
  } catch {
    // AllinOne is not running here: leave it to Claude Code.
  }
  process.exit(0);
});
