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
export interface HubSettings { agentLinks: boolean; autoReport: boolean; followMe: boolean; /** a newer release the owner can install */ newVersion?: string }

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
export type RequestState = 'pending' | 'queued' | 'accepted' | 'delivered' | 'failed' | 'unknown' | 'cancelled';

// ---------- device -> hub ----------
export type DeviceToHub =
  /** `code`: the fingerprint of the program the device runs (absent: it does not take updates). */
  | { t: 'hello'; v: number; deviceId: string; name: string; secret: string; agents: AgentInfo[]; code?: string }
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
  | { t: 'receipt'; requestId: string; state: RequestState; turnId?: string; error?: string };

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
  | { t: 'hubMoved'; hub: HubRef; members?: MemberSeed[]; handover?: string }
  /** The hub runs other code than the device: its program as a zip (base64). */
  | { t: 'update'; version: string; data: string }
  | { t: 'answer'; id: number; result?: unknown; error?: string }
  /** Start a new conversation (an agent hands work to another one); the device answers with `created`. */
  /** `first`: the message the new conversation is for, for agents whose conversations only begin with one. */
  | { t: 'create'; id: number; agentId: string; cwd: string; title: string; first?: Command }
  /** The owner sits at this computer: a reminder shown here (by the tray) instead of on the phone; `url` opens it. */
  | { t: 'alert'; title: string; text: string; url: string }
  | { t: 'tick' };

export interface HubRef { stableId: string; dnsName: string; name: string }
export interface MemberSeed { id: string; name: string; secretHash: string }

// ---------- app <-> hub ----------
export interface DeviceView { id: string; name: string; online: boolean; approved: boolean; isHub: boolean; agents: AgentInfo[]; lastSeen: number }
/** `replies` counts finished turns, so the app can show how many arrived since it last read the conversation. */
/** `replies`: finished replies so far; `readReplies`: how many of them the owner has read (kept on the hub, for every phone). */
export interface SessionView extends SessionInfo { id: string; deviceId: string; seq: number; replies?: number; readReplies?: number; muted?: boolean }
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
  | { t: 'read'; sessionId: string; replies: number }
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
