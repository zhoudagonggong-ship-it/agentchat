// Wire protocol between the hub, devices and the phone app. JSON over WebSocket.
// Every message carries a `t` discriminator. Bump PROTOCOL_VERSION on breaking changes.

export const PROTOCOL_VERSION = 1;

/** Fixed internal ports: the hub listens on 127.0.0.1:HUB_LOCAL_PORT; `tailscale serve` publishes it as HTTPS on HUB_PORT. */
export const HUB_PORT = 18801;
// The ALLINONE_*_PORT variables only in tests: a second copy runs beside the real one.
export const HUB_LOCAL_PORT = Number(process.env.ALLINONE_HUB_PORT) || 18811;
/** Every computer's local control window (and the Claude Code hook) talks to its AgentChat on 127.0.0.1:CONTROL_PORT. */
export const CONTROL_PORT = Number(process.env.ALLINONE_CONTROL_PORT) || 18812;

/** `handoff`: the hub's card, in the conversation an agent worked in, for work it handed another agent. */
export type ItemKind = 'message' | 'tool_call' | 'approval_request' | 'artifact' | 'status' | 'error' | 'handoff';

export interface AgentInfo {
  id: string; // stable per device, e.g. "codex"
  kind: 'codex' | 'claude-code' | 'opencode' | 'goose' | 'dsh';
  label: string; // shown in the UI, e.g. "Codex"
}

export interface SessionInfo {
  threadId: string; // native conversation id
  agentId: string;
  title: string;
  cwd: string | null;
  updatedAt: number; // seconds since epoch, as reported by the agent
  running: boolean;
  activeTurnId: string | null;
  /** Latest message, shortened, for the conversation list. */
  preview: string | null;
  /** The project the agent's own app files it under (e.g. a Codex desktop project), if any. */
  projectId?: string | null;
  projectName?: string | null;
  pinned?: boolean;
}

/** An agent's projects in the order its own app shows them. */
export interface ProjectInfo { id: string; name: string }

/** A device · agent the owner has (or has not yet) added as a friend. */
/** `avatar`: sha256 of the owner's own picture for it (served at /files/<sha>); `muted`: 消息免打扰 for all its conversations. */
export interface FriendView { deviceId: string; agentId: string; added: boolean; remark: string | null; acceptAgents: boolean; avatar: string | null; muted: boolean }

/** The owner's settings the hub keeps. `agentLinks`: agents may reach each other through AgentChat. */
/** `autoReport`: when work one agent handed another ends, its report goes back into the sender's conversation. */
/** `followMe`: while the owner uses one of the computers, reminders show there and the phone stays quiet. */
/** `voiceMic`: the computer whose microphone voice input listens with (the one the owner sits at), by device id. */
export interface HubSettings { agentLinks: boolean; autoReport: boolean; followMe: boolean; voiceMic?: string | null; /** a newer release the owner can install */ newVersion?: string;
  /** The order in which computers take over as hub (ids; see shift.ts). */ line?: string[] }

export interface Item {
  itemId: string; // native item id, or "turn:<id>" / "file:<sha>" / "approval:<id>"
  turnId: string | null;
  kind: ItemKind;
  ts: number; // milliseconds since epoch (best effort)
  data: Record<string, unknown>;
}

export type CommandOp = 'send' | 'interrupt' | 'approve' | 'cancel';
export type ApprovalDecision = 'accept' | 'decline' | 'cancel';

export interface Command {
  requestId: string;
  op: CommandOp;
  text?: string;
  /** Files sent with a message: uploaded to the hub first, then carried to the device. */
  files?: Attachment[];
  approvalId?: string;
  decision?: ApprovalDecision;
  /** Answers to a question card (kind "question"), by question key. */
  answers?: Record<string, string>;
  /** Sent by an agent through AgentChat rather than by the owner's phone. */
  origin?: Origin;
  /**
   * The hub sends a message again (it was not found where it should be): 1, 2… The computer looks for it first and
   * types it only when it is not there yet.
   */
  attempt?: number;
}

/**
 * Who sent a request on the owner's behalf: an agent on one of the computers. `depth`: its place in a chain of
 * hand-offs (A sends B: 1; B then sends C: 2).
 */
export interface Origin { deviceId: string; agentId: string; label: string; depth?: number; /** the sender's conversation, when known */ sessionId?: string }

/** What an agent may ask its computer's AgentChat (and the hub) through the AgentChat tool. */
export type AskOp = 'agents' | 'send' | 'wait' | 'read' | 'stop';

/** A file the phone sent. `path` is filled in on the device once it is saved there. */
export interface Attachment { sha256: string; name: string; size: number; mime: string; path?: string }

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 9;

/** How a message tells the agent about its files: one marked line each, after the text. The app hides these lines again. */
export const ATTACHMENT_MARK = '[附件]';
export function withAttachments(text: string, files: Attachment[]): string {
  const lines = files.map((f) => `${ATTACHMENT_MARK} ${f.name}：${f.path ?? f.name}`);
  return [text.trim(), lines.join('\n')].filter(Boolean).join('\n\n');
}
/** The text a request is matched by (a message with only files starts with the mark). */
export function requestText(text: string, files: Attachment[]): string {
  return text.trim() || (files.length ? ATTACHMENT_MARK : '');
}

/** Lifecycle of a phone-originated command. "unknown" is never retried automatically. */
/** How the voice box reads: listening or done well, working on it, or something went wrong. */
export type VoiceTone = 'ok' | 'busy' | 'bad';

export type RequestState ='pending' | 'queued' | 'accepted' | 'delivered' | 'failed' | 'unknown' | 'cancelled';

// ---------- device -> hub ----------
export type DeviceToHub =
  /** `code`: the fingerprint of the program the device runs (absent: it does not take updates). */
  /** `host`: the Windows computer name, which remote-desktop windows show in their titles. */
  | { t: 'hello'; v: number; deviceId: string; name: string; secret: string; agents: AgentInfo[]; code?: string; host?: string }
  /**
   * Voice input. `key`: the owner pressed the voice hotkey here (`fgProc`/`fgTitle`: the window in front then);
   * `release`: and let go of it (the owner holds it while speaking); `status`: how the microphone computer is getting
   * on, for the box on the computer spoken to (`done`: the last word); `text`: what it heard, for that computer;
   * `cancel`: given up.
   */
  | { t: 'voice'; op: 'key'; fgProc?: string; fgTitle?: string }
  | { t: 'voice'; op: 'release' }
  | { t: 'voice'; op: 'status'; text: string; tone: VoiceTone; done?: boolean }
  | { t: 'voice'; op: 'text'; text: string }
  | { t: 'voice'; op: 'cancel' }
  /** The agents found on this computer changed (one was installed while the program ran). */
  | { t: 'agents'; agents: AgentInfo[] }
  /** A file an agent here hands another agent: kept by the hub (by its hash) before the message naming it arrives. */
  | { t: 'file'; sha256: string; name: string; size: number; mime: string; data: string }
  /** Is the owner at this computer: time since the last key press or mouse move, and whether it is locked. */
  | { t: 'presence'; idleMs: number; locked: boolean }
  /** An agent here uses the AgentChat tool; the hub answers with `answer` under the same id. */
  /** `thread`: the asking agent's own conversation, when its tool knows it (Claude Code tells each of its conversations' tools). */
  | { t: 'ask'; id: number; op: AskOp; agentId: string; args: Record<string, unknown>; thread?: string }
  /** `sent`: the conversation was started with the `first` message (its receipts follow as usual). */
  | { t: 'created'; id: number; threadId?: string; sent?: boolean; error?: string }
  | { t: 'sessions'; agentId: string; sessions: SessionInfo[]; complete: boolean }
  | { t: 'projects'; agentId: string; projects: ProjectInfo[] }
  | { t: 'items'; oid: number; agentId: string; threadId: string; items: Item[] }
  | { t: 'artifact'; oid: number; agentId: string; threadId: string; itemId: string; turnId: string | null;
      name: string; size: number; sha256: string; mime: string; data: string; sent?: boolean }
  | { t: 'delta'; agentId: string; threadId: string; itemId: string; turnId: string; text: string }
  | { t: 'receipt'; requestId: string; state: RequestState; turnId?: string; error?: string }
  /**
   * Where a message carrying a request's tag was found after it was put in: the conversations (thread ids) holding it,
   * waiting or shown. `done`: the computer stopped looking (found in its own conversation, or out of time). `null`:
   * this agent's records cannot be searched, nothing is known.
   */
  | { t: 'landed'; oid: number; requestId: string; attempt: number; agentId: string; found: string[] | null; done: boolean }
  /**
   * Where this computer's copy of the hub's record is (`epoch`: the hub run it follows, '' for none; `n`: the last
   * changeset in it), asking for what follows.
   */
  | { t: 'replicaAt'; epoch: string; n: number };

// ---------- hub -> device ----------
export type HubToDevice =
  | { t: 'welcome' }
  | { t: 'pending' } // waiting for the owner to allow this device on the hub
  | { t: 'rejected'; reason: string }
  | { t: 'ack'; oid: number }
  | { t: 'hydrate'; agentId: string; threadId: string }
  /** `data` holds each attached file's bytes (base64), in the order of `command.files`. */
  | { t: 'command'; agentId: string; threadId: string; command: Command; data?: string[] }
  /**
   * The owner chose another computer as hub. Only the new hub receives `members`, so it keeps everyone allowed,
   * and `handover`: where to download the old hub's data (conversations, friends, files) before taking over.
   */
  | { t: 'hubMoved'; hub: HubRef; members?: MemberSeed[]; handover?: string; term?: number; promote?: boolean }
  /**
   * The hub's record, as it changes (see hub/replica.ts): the next changesets (base64; `n`: the first one's number),
   * or, for a computer too far behind, where to take a whole copy as of changeset `n`.
   */
  | { t: 'replica'; epoch: string; n: number; data: string[] }
  | { t: 'replicaSnapshot'; epoch: string; n: number; url: string }
  /** Files the hub's record names but the hub lacks (it took over before its copy had them all): sent as `file` if here. */
  | { t: 'wantFiles'; sha256: string[] }
  /** Who is on duty: the hub's term and the line (computer ids, in order) that takes over when it is gone (shift.ts). */
  | { t: 'shift'; term: number; line: HubRef[] }
  /** The hub runs other code than the device: its program as a zip (base64). */
  | { t: 'update'; version: string; data: string }
  | { t: 'answer'; id: number; result?: unknown; error?: string }
  /** Start a new conversation (an agent hands work to another one); the device answers with `created`. */
  /** `first`: the message the new conversation is for, for agents whose conversations only begin with one. */
  /** `data`: the files of `first`, base64, in its order (as with `command`). */
  | { t: 'create'; id: number; agentId: string; cwd: string; title: string; first?: Command; data?: string[] }
  /** The owner sits at this computer: a reminder shown here (by the tray) instead of on the phone; `url` opens it. */
  | { t: 'alert'; title: string; text: string; url: string }
  /**
   * Voice input. To the microphone computer: `listen` (the owner holds the hotkey and speaks; `context`: words and
   * background for the recognizer), `finish` (let go).
   * To the computer spoken to, where the owner looks: `show` how it goes in the box by the cursor (`done`: the last
   * word, the box goes away soon after), `paste` the text where its cursor is.
   */
  | { t: 'voice'; op: 'listen'; context?: string }
  | { t: 'voice'; op: 'finish' }
  | { t: 'voice'; op: 'show'; text: string; tone: VoiceTone; done?: boolean }
  | { t: 'voice'; op: 'paste'; text: string }
  | { t: 'tick' };

export interface HubRef { stableId: string; dnsName: string; name: string }
export interface MemberSeed { id: string; name: string; secretHash: string }

// ---------- app <-> hub ----------
export interface DeviceView { id: string; name: string; online: boolean; approved: boolean; isHub: boolean; agents: AgentInfo[]; lastSeen: number }
/** `replies` counts finished turns, so the app can show how many arrived since it last read the conversation. */
/** `replies`: finished replies so far; `readReplies`: how many of them the owner has read (kept on the hub, for every phone). */
/**
 * `quiet`/`readQuiet`: the same for replies to other agents' messages, shown unobtrusively, never reminded of.
 * `caredAt`: when the conversation last had something for the owner (their message, or a reply to it): the list's order.
 */
export interface SessionView extends SessionInfo { id: string; deviceId: string; seq: number; replies?: number; readReplies?: number; muted?: boolean;
  quiet?: number; readQuiet?: number; caredAt?: number }
export interface ItemView extends Item { sessionId: string; seq: number }
export interface RequestView { requestId: string; sessionId: string; op: CommandOp; text: string | null; files?: Attachment[]; state: RequestState; turnId: string | null; error: string | null; createdAt: number; seq: number }

export type AppToHub =
  | { t: 'hello'; v: number; after: number }
  | { t: 'open'; sessionId: string; after: number }
  | { t: 'artifacts' }
  /** `avatar`: the sha256 of a picture uploaded first (/api/upload), or null for the default. `muted`: 消息免打扰. */
  | { t: 'friend'; deviceId: string; agentId: string; added?: boolean; remark?: string | null; acceptAgents?: boolean; avatar?: string | null; muted?: boolean }
  | { t: 'settings'; settings: Partial<HubSettings> }
  | { t: 'installUpdate' }
  | { t: 'read'; sessionId: string; replies: number; quiet?: number }
  /** Pinned by the owner in the app (never taken from an agent's own app). */
  | { t: 'pin'; sessionId: string; pinned: boolean }
  /** 消息免打扰 for one conversation: no 「完成了一轮」 notices (approvals still come), a quiet unread mark. */
  | { t: 'mute'; sessionId: string; muted: boolean }
  | { t: 'command'; sessionId: string; command: Command };

export type HubToApp =
  | { t: 'version'; web: string }
  | { t: 'devices'; devices: DeviceView[] }
  | { t: 'friends'; friends: FriendView[] }
  | { t: 'settings'; settings: HubSettings }
  | { t: 'projects'; deviceId: string; agentId: string; projects: ProjectInfo[] }
  | { t: 'sessions'; sessions: SessionView[]; archived: string[]; seq: number }
  | { t: 'items'; sessionId: string; items: ItemView[] }
  /** Items across all conversations: pending approvals (sent on hello) or every output file (on request). */
  | { t: 'collection'; name: 'approvals' | 'artifacts'; items: ItemView[] }
  | { t: 'requests'; requests: RequestView[] }
  | { t: 'delta'; sessionId: string; itemId: string; turnId: string; text: string }
  | { t: 'error'; message: string }
  | { t: 'hubMoved'; url: string }
  | { t: 'tick' };

/** Session ids are globally unique: device + agent + native thread id. */
export function sessionKey(deviceId: string, agentId: string, threadId: string): string {
  return `${deviceId}:${agentId}:${threadId}`;
}

/**
 * The mark the hub puts before a message one agent sends another: who from, which conversation it is for, and the
 * request's tag (「[来自 X「对话」，经 AgentChat 转发给「对话」 #1a2b3c4d] …」). The tag tells which request a message
 * in a conversation is, whatever the agent's app did to the text around it; the addressee lets an agent that got it
 * by mistake see it is not for it.
 */
export function forwardMark(from: string, requestId: string, to?: string): string {
  return `[来自 ${from}，经 AgentChat 转发${to ? `给「${to.slice(0, 40)}」` : ''} #${tag(requestId)}]`;
}

/** A request's tag: the start of its id. */
export function tag(requestId: string): string {
  return requestId.slice(0, 8);
}

/**
 * Whether text holds a forwarded message's mark with this tag, anywhere in it: a raw line of an agent's records
 * (JSON, with whatever the app put before the message) as well as the message itself.
 */
export function carriesTag(text: string, tag: string): boolean {
  if (!/^[0-9a-f]{8}$/.test(tag)) return false;
  // Some apps write the Chinese of the mark as \uXXXX escapes: the tag closing a bracket is mark enough, unless it is
  // AgentChat's own correction (「[AgentChat 更正 #…]」), which only names the tag.
  return new RegExp(`(?<!更正 |\\\\u6b63 )#${tag}\\]`).test(text);
}

/**
 * What a message sent through AgentChat's tool is known by in the sending agent's own records of the call: its first
 * line's letters and digits only (the records quote it in JSON, in code, escaped as \uXXXX…), at most 24.
 */
export function callKey(text: string): string {
  return letters(text.trim().split('\n')[0] ?? '').slice(0, 24);
}

/** Whether a raw line of an agent's records holds a call of AgentChat's tool carrying the message `key` stands for. */
export function recordsCall(raw: string, key: string): boolean {
  if (key.length < 4 || !/allinone/i.test(raw)) return false;
  // \uXXXX back to letters, and the escaped line breaks (\n) out of the way, before keeping letters and digits only.
  const plain = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\[nrt]/g, ' ');
  return letters(plain).includes(key);
}

function letters(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, '');
}

/** The request tag in a forwarded message's mark, if it has one. */
export function markTag(text: string): string | null {
  return /^\s*\[来自 [^\]]*经 (?:AgentChat|AllinOne) 转发[^\]#]*#([0-9a-f]{8})\]/.exec(text)?.[1] ?? null;
}
