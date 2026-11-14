import type { Ctx, MemoryItem, MemoryKind, Settings } from "../shared/packages/protocol/src/index";
import { DEFAULT_SETTINGS, DEFAULT_TALK_STATE, normalizeMemoryText, type TalkState } from "./api-store";


/**
 * 대화 쪽이 쓰는 저장소 모양(전부 동기). 운영에서는 ServerApi의 sqlite 구현을 넣고,
 * 시험과 단독 실행에서는 InMemoryTalkStore를 쓴다.
 */
export interface TalkStore {
  getSettings(installId: string): Settings;
  patchSettings(installId: string, patch: Partial<Settings>): Settings;
  /** 기억 동의가 있고 settings.memoryEnabled 가 켜져 있을 때만 true. 쓰기와 떠올리기 모두 이 값을 따른다. */
  memoryAllowed(installId: string): boolean;
  /** AC-4.9-05: `record` 와 `external_ai` 동의가 둘 다 허용일 때만 true. 아니면 LLM·TTS 로 아무것도 보내지 않는다. */
  talkAllowed(installId: string): boolean;
  /** 최신순 */
  listMemory(installId: string, limit: number): MemoryItem[];
  addMemory(installId: string, kind: MemoryKind, text: string): MemoryItem;
  deleteMemory(installId: string, id: string): boolean;
  getTalkState(installId: string): TalkState;
  patchTalkState(installId: string, patch: Partial<TalkState>): TalkState;
  /** 선택: 차량 이벤트 기록(좌표 키는 호출 전에 이미 버려진다). */
  recordVehicleEvent?(installId: string, ctx: Ctx): void;
}

/** 프로세스 메모리에만 두는 저장소. 재시작하면 사라진다. */
export class InMemoryTalkStore implements TalkStore {
  private readonly settings = new Map<string, Settings>();
  private readonly memory = new Map<string, MemoryItem[]>();
  private readonly state = new Map<string, TalkState>();
  /** 시험에서 동의 철회를 흉내 낸다. */
  consentGranted = true;
  /** 시험에서 녹음·외부 AI 동의가 없는 차를 흉내 낸다. */
  talkConsent = true;

  getSettings(id: string): Settings {
    return { ...(this.settings.get(id) ?? DEFAULT_SETTINGS) };
  }
  patchSettings(id: string, patch: Partial<Settings>): Settings {
    const next = { ...this.getSettings(id), ...patch };
    this.settings.set(id, next);
    return { ...next };
  }
  memoryAllowed(id: string): boolean {
    return this.consentGranted && this.getSettings(id).memoryEnabled;
  }
  talkAllowed(): boolean {
    return this.talkConsent;
  }
  listMemory(id: string, limit: number): MemoryItem[] {
    const seen = new Set<string>();
    return [...(this.memory.get(id) ?? [])].reverse().filter((m) => {
      const k = normalizeMemoryText(m.text);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, limit);
  }
  addMemory(id: string, kind: MemoryKind, text: string): MemoryItem {
    const key = normalizeMemoryText(text);
    const dup = (this.memory.get(id) ?? []).find((m) => normalizeMemoryText(m.text) === key);
    if (dup) return dup;
    const item: MemoryItem = { id: crypto.randomUUID(), kind, text, createdAt: new Date().toISOString() };
    this.memory.set(id, [...(this.memory.get(id) ?? []), item]);
    return item;
  }
  deleteMemory(id: string, memId: string): boolean {
    const all = this.memory.get(id) ?? [];
    const target = all.find((m) => m.id === memId);
    if (!target) return false;
    const key = normalizeMemoryText(target.text);
    const next = all.filter((m) => normalizeMemoryText(m.text) !== key);
    this.memory.set(id, next);
    return next.length !== all.length;
  }
  getTalkState(id: string): TalkState {
    return { ...(this.state.get(id) ?? DEFAULT_TALK_STATE) };
  }
  patchTalkState(id: string, patch: Partial<TalkState>): TalkState {
    const next = { ...this.getTalkState(id), ...patch };
    this.state.set(id, next);
    return { ...next };
  }
  /** 시험용: 이 차의 기억 전부 */
  all(id: string): MemoryItem[] {
    return [...(this.memory.get(id) ?? [])];
  }
  /** 시험용: 동의 철회 = 기억 즉시 삭제 + 이후 저장 불가 */
  withdraw(id: string): void {
    this.consentGranted = false;
    this.memory.delete(id);
  }
}
